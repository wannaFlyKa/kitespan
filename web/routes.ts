// The one route table (DESIGN.md section 5.2) lives in shared/route.ts, where the server reads it too; the page's
// screens, its tests and the click-through import it through this file.
export {
  APP_EXACT_PATHS,
  APP_PATH_PREFIXES,
  CHAT_FILTERS,
  PANE_ROUTES,
  PANEL_ROUTES,
  PERMISSION_ANSWERS,
  PLAN_ANSWERS,
  ROUTES,
  ROUTE_BY_NAME,
  SETTINGS_SECTIONS,
  SETTING_KEYS,
  SHELL_TYPES,
  VIEW_IDS,
  isAppPath,
  type QuerySpec,
  type RouteDef,
  type RouteKind,
} from "../shared/route";
