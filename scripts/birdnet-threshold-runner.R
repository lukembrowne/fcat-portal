#!/usr/bin/env Rscript
#
# BirdNET confidence-threshold fitter.
#
# Converts a species' expert-reviewed detection sample into a probability
# threshold, following Wood & Kahl (2024, J Ornithol 165:777-782):
#
#   1. Transform BirdNET confidence to its logit  x = log(c / (1 - c)).
#      The [0,1] confidence scale compresses the high-score region where the
#      threshold lives; the unbounded logit does not.
#   2. Fit  glm(outcome ~ x, family = binomial).
#   3. Solve for the score at a target probability p:
#        x* = (log(p / (1 - p)) - b0) / b1
#   4. Back-transform to the confidence scale: c* = 1 / (1 + exp(-x*)).
#
# The standard error of x* comes from the delta method on that ratio — the same
# computation MASS::dose.p performs, done inline so the container's R needs no
# package beyond jsonlite. (tests/python has no equivalent; the TS side
# cross-checks these numbers against dose.p.)
#
# WORKER-LOOP PROTOCOL (mirrors scripts/occupancy-runner.R): load libraries once,
# emit {type:"ready"}, then read ONE JSON config per line from stdin and stream
# back ONE NDJSON result per config until EOF. A per-config error is caught and
# emitted as {type:"error"} — one bad campaign never kills the worker.
#
# Config in:
#   {"id": 12, "species": "Ramphastos ambiguus",
#    "observations": [{"conf": 0.83, "outcome": 1}, ...],
#    "probabilities": [0.9, 0.95, 0.99], "minReviews": 20}
#
# Result out (usable):
#   {"type":"result","id":12,"usable":true,"intercept":...,"slope":...,
#    "converged":true,"nReviewed":200,"nCorrect":143,
#    "thresholds":{"0.9":{"conf":...},"0.95":{"conf":...,"se":...,"lower":...,"upper":...}}}
#
# Result out (unusable — the COMMON case; most species BirdNET reports have no
# true positives at any score):
#   {"type":"result","id":12,"usable":false,"reason":"complete_separation", ...}

suppressWarnings(suppressMessages({
  library(jsonlite)
}))

emit <- function(obj) {
  cat(toJSON(obj, auto_unbox = TRUE, na = "null", digits = 10), "\n", sep = "")
  flush(stdout())
}

# Confidence is clamped before the logit transform. BirdNET emits exact 1.0
# values (13 rows for Ramphastos ambiguus in the real data) and log(1/0) is Inf,
# which would poison every coefficient in the fit.
CLAMP_MIN <- 0.001
CLAMP_MAX <- 0.999

confToLogit <- function(conf) {
  c <- pmin(CLAMP_MAX, pmax(CLAMP_MIN, conf))
  log(c / (1 - c))
}

logitToConf <- function(x) 1 / (1 + exp(-x))

unusable <- function(reqId, reason, nReviewed, nCorrect) {
  list(
    type = "result", id = reqId, usable = FALSE, reason = reason,
    nReviewed = nReviewed, nCorrect = nCorrect
  )
}

#' Threshold on the logit scale at probability p, with its delta-method SE.
#'
#' x* = (logit(p) - b0) / b1 is a ratio of correlated estimates, so its variance
#' needs the full covariance matrix, not just the marginal SEs:
#'
#'   d(x*)/d(b0) = -1 / b1
#'   d(x*)/d(b1) = -(logit(p) - b0) / b1^2  =  -x* / b1
#'
#'   Var(x*) = g' V g   for g = (d/db0, d/db1)
thresholdAt <- function(fit, p) {
  co <- coef(fit)
  b0 <- co[[1]]
  b1 <- co[[2]]
  target <- log(p / (1 - p))
  xStar <- (target - b0) / b1

  V <- vcov(fit)
  g <- c(-1 / b1, -xStar / b1)
  varX <- as.numeric(t(g) %*% V %*% g)
  seX <- if (is.finite(varX) && varX >= 0) sqrt(varX) else NA_real_

  list(xStar = xStar, seX = seX)
}

fitOne <- function(cfg) {
  reqId <- if (is.null(cfg$id)) NA_integer_ else cfg$id
  probs <- if (is.null(cfg$probabilities)) c(0.9, 0.95, 0.99) else as.numeric(unlist(cfg$probabilities))
  minReviews <- if (is.null(cfg$minReviews)) 20L else as.integer(cfg$minReviews)

  obs <- cfg$observations
  if (is.null(obs) || length(obs) == 0) {
    emit(unusable(reqId, "insufficient_sample", 0L, 0L))
    return(invisible(NULL))
  }

  conf <- vapply(obs, function(o) as.numeric(o$conf)[1], numeric(1))
  outcome <- vapply(obs, function(o) as.integer(o$outcome)[1], integer(1))

  keep <- is.finite(conf) & !is.na(outcome)
  conf <- conf[keep]
  outcome <- outcome[keep]

  nReviewed <- length(outcome)
  nCorrect <- sum(outcome == 1L)

  if (nReviewed < minReviews) {
    emit(unusable(reqId, "insufficient_sample", nReviewed, nCorrect))
    return(invisible(NULL))
  }

  # Complete separation: every review agrees. glm would "converge" with a slope
  # running off to +/-Inf and a threshold that is pure noise. This is the
  # expected outcome for most species, not an exceptional one.
  if (nCorrect == 0L || nCorrect == nReviewed) {
    emit(unusable(reqId, "complete_separation", nReviewed, nCorrect))
    return(invisible(NULL))
  }

  x <- confToLogit(conf)
  df <- data.frame(outcome = outcome, x = x)

  fit <- tryCatch(
    suppressWarnings(glm(outcome ~ x, family = binomial(), data = df)),
    error = function(e) NULL
  )
  if (is.null(fit)) {
    emit(unusable(reqId, "fit_failed", nReviewed, nCorrect))
    return(invisible(NULL))
  }

  co <- coef(fit)
  b0 <- co[[1]]
  b1 <- co[[2]]

  if (!is.finite(b0) || !is.finite(b1)) {
    emit(unusable(reqId, "fit_failed", nReviewed, nCorrect))
    return(invisible(NULL))
  }

  # A non-positive slope means accuracy does not rise with BirdNET's score, so
  # no threshold can separate true from false. Wood & Kahl report never seeing
  # this in ~1000 classes, which makes it a strong signal that something else is
  # wrong (mislabelled reviews, a confounding sound) rather than a fittable
  # relationship.
  if (b1 <= 0) {
    emit(unusable(reqId, "non_monotonic", nReviewed, nCorrect))
    return(invisible(NULL))
  }

  thresholds <- list()
  primary <- NULL
  for (p in probs) {
    tp <- thresholdAt(fit, p)
    confStar <- logitToConf(tp$xStar)
    entry <- list(conf = confStar, logit = tp$xStar, se = tp$seX)
    if (abs(p - 0.95) < 1e-9) {
      # 95% CI on the logit-scale threshold, back-transformed. Doing the
      # interval on the logit scale keeps it inside (0,1) after transformation
      # rather than producing a bound above 1.
      if (is.finite(tp$seX)) {
        entry$lower <- logitToConf(tp$xStar - 1.96 * tp$seX)
        entry$upper <- logitToConf(tp$xStar + 1.96 * tp$seX)
      }
      primary <- confStar
    }
    thresholds[[as.character(p)]] <- entry
  }

  # A threshold at or above 1.0 means no confidence value BirdNET can emit
  # reaches the target probability. logitToConf() saturates rather than
  # exceeding 1, so test the logit against the clamp instead of the
  # back-transformed value.
  if (!is.null(primary) && primary >= CLAMP_MAX) {
    emit(unusable(reqId, "threshold_out_of_range", nReviewed, nCorrect))
    return(invisible(NULL))
  }

  emit(list(
    type = "result",
    id = reqId,
    usable = TRUE,
    intercept = b0,
    slope = b1,
    converged = isTRUE(fit$converged),
    nReviewed = nReviewed,
    nCorrect = nCorrect,
    thresholds = thresholds
  ))
}

main <- function() {
  emit(list(
    type = "ready",
    R = paste(R.version$major, R.version$minor, sep = ".")
  ))

  con <- file("stdin", open = "r")
  on.exit(close(con), add = TRUE)
  repeat {
    line <- readLines(con, n = 1L, warn = FALSE)
    if (length(line) == 0) break          # EOF — stdin closed
    if (!nzchar(trimws(line))) next       # skip blank keep-alive lines
    cfg <- tryCatch(
      fromJSON(line, simplifyVector = FALSE),
      error = function(e) {
        emit(list(type = "error", id = NA_integer_,
                  message = paste("bad config json:", conditionMessage(e))))
        NULL
      }
    )
    if (is.null(cfg)) next
    tryCatch(
      fitOne(cfg),
      error = function(e) emit(list(
        type = "error",
        id = if (is.null(cfg$id)) NA_integer_ else cfg$id,
        message = conditionMessage(e)
      ))
    )
  }
}

# Only startup/IO failures reach here; per-config errors are caught in the loop.
tryCatch(main(), error = function(e) {
  emit(list(type = "error", id = NA_integer_, message = conditionMessage(e)))
  quit(status = 1, save = "no")
})
