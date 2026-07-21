/**
 * Financial dashboard constants.
 *
 * Monthly expense proportions from historical data (used for budget proration).
 * Account code prefixes for transaction classification.
 * Expense categories related to salaries.
 */

/** Monthly expense proportions — NOT evenly distributed across the year */
export const MONTHLY_EXPENSE_PROPORTIONS = [
  0.08547746817, // Jan
  0.06534539574, // Feb
  0.05767899071, // Mar
  0.0601082849, // Apr
  0.09031982952, // May
  0.1183670348, // Jun
  0.105599112, // Jul
  0.1138121299, // Aug
  0.06201647515, // Sep
  0.06026778576, // Oct
  0.07409563639, // Nov
  0.1069118569, // Dec
];

/** Days in each month (non-leap year) */
export const DAYS_IN_MONTHS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/**
 * Account categories excluded from "operating expenses" for runway calculation.
 *
 * These are large, lumpy capital / financing outlays — NOT recurring operating
 * costs — so they are kept out of the annual operating-budget figure and out of
 * the month-by-month "Gastos Proy." spread. Track them instead as one-off
 * entries in the Proyecciones table ("Gastos Adic."), which is where they hit
 * the projected balance. Keeping a capital item in BOTH places double-counts it.
 *
 * NOTE: only the capital vehicle *purchase* ("Purchase new Vehicles") is
 * excluded. Recurring vehicle running costs (Vehicle - Maintenance / Insurance /
 * Gasoline and Oil / Revision and Matricula) are genuine operating expenses and
 * stay IN the operating budget.
 */
export const NON_OPERATING_CATEGORIES = [
  "Land acquisition",
  "New construction",
  "Loan repayment",
  "Purchase new Vehicles",
];

/**
 * Human-readable Spanish labels for the excluded capital/financing categories,
 * shown in the cash-flow UI so it's clear what the operating figure leaves out.
 * Keep in sync with NON_OPERATING_CATEGORIES.
 */
export const NON_OPERATING_LABELS_ES: Record<string, string> = {
  "Land acquisition": "compra de terreno",
  "New construction": "construcción",
  "Loan repayment": "pago de préstamos",
  "Purchase new Vehicles": "compra de vehículos",
};

/** Budget categories defined in the annual budget */
export const BUDGET_CATEGORIES = [
  "Personnel Total with Contract",
  "Personnel Total without Contract",
  "Food",
  "Transport",
  "Supplies and Materials",
  "Lodging",
  "Reserve Maintenance",
  "Cleaning Supplies",
  "Vehicle - Maintenance",
  "Vehicle - Revision and Matricula",
  "Vehicle - Insurance",
  "Vehicle - Gasoline and Oil",
  "Office rent + cleaning",
  "Utilities - electricity, water, telephone",
  "Internet",
  "Link system contract",
  "Freight and shipping",
  "Computer maintenance",
  "Workshops / Conferences / Professional development",
  "Publicidad/Promociones",
  "Invited Researchers / Temporal Researchers / Consultants",
  "Bank Charges",
  "Radio System",
  "Legal Services",
  "Security Guards",
  "Community Support",
  "Contingency",
  "Land acquisition",
  "Vehicles",
  "New construction",
  "Loan repayment",
  "Liquidaciones",
] as const;

/** Salary-related expense categories in the accounting system */
export const SUELDO_CATEGORIES = [
  "SUELDOS",
  "DECIMO TERCERO",
  "DECIMO CUARTO",
  "APORTE PATRONAL",
  "FONDOS DE RESERVA",
  "VACACIONES",
  "DESAHUCIO Y JUBILACION",
  "HONORARIOS PROFESIONALES",
  "SERVICIOS PRESTADOS",
  "GUARDABOSQUE",
  "TRABAJOS OCASIONALES",
] as const;

/** Cash reserve target (3 months of operating expenses, ~$140k) */
export const CASH_RESERVE_TARGET = 140000;

/** LibroMayor CSV expected columns (tab-separated, ISO-8859-1) */
export const LIBRO_MAYOR_COLUMNS = [
  "CUENTA CóDIGO",
  "CUENTA NOMBRE",
  "FECHA",
  "# ASIENTO",
  "COMPROBANTE",
  "USUARIO",
  "DETALLE",
  "DOC.",
  "C. COSTO",
  "CENTROS DE INGRESO",
  "IDENTIFICACION",
  "ACTOR",
  "DEBE",
  "HABER",
  "SALDO ACT",
] as const;
