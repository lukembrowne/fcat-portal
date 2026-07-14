#!/usr/bin/env Rscript
# Occupancy model runner — single-season single-species (MacKenzie) via unmarked::occu.
#
# Contract (mirrors scripts/birdnet-runner.py): reads ONE JSON config object from
# stdin, streams NDJSON result lines to stdout, one JSON object per line, each
# tagged with a `type`. The TS bridge (src/lib/occupancy/runner.ts) parses these.
# The process resolves with exit code 0 on success (after emitting {type:"result"})
# or non-zero after emitting {type:"error"}; it never prompts.
#
# Input config shape:
#   {
#     "species": str, "stream": "camera"|"audio", "binWidth": int,
#     "y": [[0|1|null, ...], ...],              # sites x occasions detection history
#     "siteCovs":   { "<name>": [ ... nSites ] },
#     "siteFactors": ["habitat", ...],           # which siteCovs are categorical
#     "obsCovs":    { "<name>": [[ ... occ], ...] }, # sites x occasions
#     "obsFactors": [],                          # which obsCovs are categorical
#                                                #   (effort is numeric/continuous)
#     "psiFormula": "~forest + elev + habitat",  # occupancy (state) formula
#     "detFormula": "~effort",                   # detection formula
#     "grid":       { "<name>": [ ... nCells ] } | null  # optional prediction grid
#   }
#
# Emits:
#   {"type":"version", ...}
#   {"type":"result", ...model summary + predictions...}
#   {"type":"error","message": "..."}

suppressWarnings(suppressMessages({
  library(jsonlite)
  library(unmarked)
}))

emit <- function(obj) {
  cat(toJSON(obj, auto_unbox = TRUE, na = "null", digits = 8), "\n", sep = "")
  flush(stdout())
}

fail <- function(msg) {
  emit(list(type = "error", message = as.character(msg)))
  quit(status = 1, save = "no")
}

main <- function() {
  emit(list(
    type = "version",
    unmarked = as.character(packageVersion("unmarked")),
    R = paste(R.version$major, R.version$minor, sep = ".")
  ))

  raw <- paste(readLines("stdin", warn = FALSE), collapse = "\n")
  if (!nzchar(raw)) fail("empty config on stdin")
  # simplifyVector=FALSE keeps everything as nested lists so JSON null stays a
  # length-0 element (rather than being dropped by simplification), which is the
  # only reliable way to preserve NA positions in the ragged detection history.
  cfg <- fromJSON(raw, simplifyVector = FALSE)

  # Cell accessors: null / length-0 -> NA (never a length-zero replacement).
  numCell <- function(v) if (is.null(v) || length(v) == 0) NA_real_ else as.numeric(v)[1]
  chrCell <- function(v) if (is.null(v) || length(v) == 0) NA_character_ else as.character(v)[1]

  # --- detection-history matrix (JSON null -> NA) ---
  yrows <- cfg$y
  nSites <- length(yrows)
  if (nSites == 0) fail("no sites in detection history")
  nOcc <- length(yrows[[1]])
  y <- matrix(NA_real_, nrow = nSites, ncol = nOcc)
  for (i in seq_len(nSites)) {
    row <- yrows[[i]]
    for (j in seq_len(nOcc)) y[i, j] <- numCell(row[[j]])
  }

  # --- site covariates ---
  siteFactors <- if (is.null(cfg$siteFactors)) character(0) else unlist(cfg$siteFactors)
  siteCovs <- data.frame(row.names = seq_len(nSites))
  if (!is.null(cfg$siteCovs)) {
    for (nm in names(cfg$siteCovs)) {
      vals <- unlist(cfg$siteCovs[[nm]])
      siteCovs[[nm]] <- if (nm %in% siteFactors) factor(vals) else as.numeric(vals)
    }
  }

  # --- observation (detection) covariates: each is a sites x occasions matrix ---
  obsFactors <- if (is.null(cfg$obsFactors)) character(0) else unlist(cfg$obsFactors)
  obsCovs <- list()
  if (!is.null(cfg$obsCovs)) {
    for (nm in names(cfg$obsCovs)) {
      rows <- cfg$obsCovs[[nm]]
      isFactor <- nm %in% obsFactors
      # Categorical obs covariates (listed in obsFactors) build a character matrix
      # — unmarked coerces it to a factor. Everything else (e.g. continuous
      # survey effort = active days per occasion) builds a NUMERIC matrix, giving
      # a single slope instead of per-level dummies.
      m <- matrix(if (isFactor) NA_character_ else NA_real_, nrow = nSites, ncol = nOcc)
      for (i in seq_len(nSites)) {
        r <- rows[[i]]
        for (j in seq_len(nOcc)) {
          m[i, j] <- if (isFactor) chrCell(r[[j]]) else numCell(r[[j]])
        }
      }
      obsCovs[[nm]] <- m
    }
  }

  # An empty obsCovs list() is rejected ("elements must be named"); pass NULL.
  obsCovsArg <- if (length(obsCovs) > 0) obsCovs else NULL
  # Likewise a 0-column siteCovs data.frame is fragile — pass NULL for an
  # intercept-only occupancy model.
  siteCovsArg <- if (ncol(siteCovs) > 0) siteCovs else NULL
  umf <- tryCatch(
    unmarkedFrameOccu(y = y, siteCovs = siteCovsArg, obsCovs = obsCovsArg),
    error = function(e) fail(paste("unmarkedFrameOccu failed:", conditionMessage(e)))
  )

  form <- as.formula(paste(cfg$detFormula, cfg$psiFormula))
  t0 <- Sys.time()
  m <- tryCatch(
    occu(form, data = umf),
    error = function(e) fail(paste("occu fit failed:", conditionMessage(e)))
  )
  fitSecs <- as.numeric(difftime(Sys.time(), t0, units = "secs"))

  # Coefficient table (link scale): estimate, se, z, p for state + det params.
  est <- tryCatch(coef(m), error = function(e) NULL)
  se <- tryCatch(SE(m), error = function(e) rep(NA_real_, length(est)))
  if (is.null(est)) fail("model produced no coefficients (did not converge)")
  z <- est / se
  pval <- 2 * pnorm(-abs(z))
  effects <- lapply(seq_along(est), function(k) {
    list(param = names(est)[k], estimate = est[[k]], se = se[[k]],
         z = z[[k]], p = pval[[k]])
  })

  # Overall occupancy / detection on the probability scale (mean over sites).
  # The per-site prediction carries lower/upper; the study-area estimate is the
  # mean of the point estimates and its interval is the mean of the per-site
  # 95% bounds (the "average site" interval, not a formal CI on the mean).
  psiSite <- tryCatch(predict(m, type = "state", newdata = siteCovs),
                      error = function(e) NULL)
  pObs <- tryCatch(predict(m, type = "det"), error = function(e) NULL)
  meanPsi <- if (!is.null(psiSite)) mean(psiSite$Predicted, na.rm = TRUE) else NA_real_
  occLower <- if (!is.null(psiSite)) mean(psiSite$lower, na.rm = TRUE) else NA_real_
  occUpper <- if (!is.null(psiSite)) mean(psiSite$upper, na.rm = TRUE) else NA_real_
  meanP <- if (!is.null(pObs)) mean(pObs$Predicted, na.rm = TRUE) else NA_real_

  # Naive occupancy = fraction of sites with >=1 detection.
  naive <- mean(apply(y, 1, function(r) any(r == 1, na.rm = TRUE)))

  result <- list(
    type = "result",
    species = cfg$species,
    stream = cfg$stream,
    nSites = nSites,
    nOccasions = nOcc,
    convergence = if (!is.null(m@opt$convergence)) m@opt$convergence else NA_integer_,
    aic = tryCatch(m@AIC, error = function(e) NA_real_),
    fitSeconds = fitSecs,
    naiveOccupancy = naive,
    estimatedOccupancy = meanPsi,
    occupancyLower = occLower,
    occupancyUpper = occUpper,
    meanDetection = meanP,
    effects = effects
  )

  # --- response curves + habitat-use (predicted psi with 95% CIs) ---
  # Continuous covariates are standardized (z); build each curve over the
  # observed z-range, holding the OTHER continuous covariates at 0 (their mean)
  # and factors at their modal level, then relabel x in RAW units via the
  # standardization params so the charts read in cover-fraction / metres.
  stdz <- cfg$standardizations
  rawX <- function(nm, z) {
    s <- stdz[[nm]]
    if (is.null(s)) return(z)
    as.numeric(s$mean) + z * as.numeric(s$sd)
  }
  contNames <- setdiff(names(siteCovs), siteFactors)
  modalLevel <- function(nm) names(sort(table(siteCovs[[nm]]), decreasing = TRUE))[1]
  refRow <- function(n) {
    df <- data.frame(row.names = seq_len(n))
    for (nm in contNames) df[[nm]] <- rep(0, n)
    for (nm in siteFactors) {
      df[[nm]] <- factor(rep(modalLevel(nm), n), levels = levels(siteCovs[[nm]]))
    }
    df
  }

  curves <- list()
  for (nm in contNames) {
    zseq <- seq(min(siteCovs[[nm]], na.rm = TRUE),
                max(siteCovs[[nm]], na.rm = TRUE), length.out = 40)
    nd <- refRow(length(zseq))
    nd[[nm]] <- zseq
    pc <- tryCatch(predict(m, type = "state", newdata = nd), error = function(e) NULL)
    if (!is.null(pc)) {
      curves[[nm]] <- lapply(seq_along(zseq), function(k) {
        list(x = rawX(nm, zseq[k]), psi = pc$Predicted[k],
             lower = pc$lower[k], upper = pc$upper[k])
      })
    }
  }
  if (length(curves) > 0) result$curves <- curves

  if (length(siteFactors) > 0) {
    hf <- siteFactors[1]
    lvls <- levels(siteCovs[[hf]])
    nd <- refRow(length(lvls))
    nd[[hf]] <- factor(lvls, levels = lvls)
    ph <- tryCatch(predict(m, type = "state", newdata = nd), error = function(e) NULL)
    if (!is.null(ph)) {
      result$habitatUse <- lapply(seq_along(lvls), function(k) {
        list(habitat = lvls[k], psi = ph$Predicted[k], lower = ph$lower[k],
             upper = ph$upper[k], isReference = (k == 1))
      })
    }
  }

  # --- optional AOI grid prediction ---
  if (!is.null(cfg$grid)) {
    gridN <- length(cfg$grid[[1]])
    gridDF <- data.frame(row.names = seq_len(gridN))
    for (nm in names(cfg$grid)) {
      vals <- unlist(cfg$grid[[nm]])
      gridDF[[nm]] <- if (nm %in% siteFactors) {
        factor(vals, levels = levels(siteCovs[[nm]]))
      } else as.numeric(vals)
    }
    # Model terms absent from the grid (a factor like habitat has no raster
    # surface) must still be supplied to predict(). Hold each at its modal
    # observed level so the map shows psi across the *mappable* gradients
    # (forest, elevation) with habitat fixed at its most common category.
    for (nm in siteFactors) {
      if (!(nm %in% names(gridDF))) {
        obs <- siteCovs[[nm]]
        modal <- names(sort(table(obs), decreasing = TRUE))[1]
        gridDF[[nm]] <- factor(rep(modal, gridN), levels = levels(obs))
      }
    }
    g0 <- Sys.time()
    pr <- tryCatch(predict(m, type = "state", newdata = gridDF),
                   error = function(e) NULL)
    if (!is.null(pr)) {
      result$prediction <- list(
        psi = pr$Predicted,
        se = pr$SE,
        lower = pr$lower,
        upper = pr$upper
      )
      result$predictSeconds <- as.numeric(difftime(Sys.time(), g0, units = "secs"))
    }
  }

  emit(result)
  emit(list(type = "complete"))
}

tryCatch(main(), error = function(e) fail(conditionMessage(e)))
