// ============================================================
// Core type definitions for the Hsinchu Garbage Truck LINE Bot
// ============================================================

// ── Database types (Supabase) ────────────────────────────────

export interface User {
  id: string; // UUID
  line_user_id: string;
  home_location: string | null; // WKT: POINT(lng lat) returned by PostGIS
  created_at: string;
}

export interface TruckRoute {
  id: string; // e.g. "Xiangshan-01" or routeId from HCCG
  name: string;
  type: "general" | "recycle";
}

export interface RouteStop {
  id: string; // UUID
  route_id: string;
  sequence_order: number;
  location: string | null; // WKT from PostGIS
  scheduled_time: string | null; // "HH:MM"
  // Extra fields from HCCG API (for enriched seeds)
  point_name?: string;
  address?: string;
  lat?: number;
  lng?: number;
}

export interface NearestStopResult {
  id: string;
  route_id: string;
  sequence_order: number;
  scheduled_time: string | null;
  point_name: string | null;
  address: string | null;
  lat: number;
  lng: number;
  distance_meters: number;
}

// ── Redis types (Upstash) ────────────────────────────────────

export interface TruckLiveData {
  lat: number;
  lng: number;
  speed: number; // km/h
  updated_at: string; // ISO 8601
  heading_to_stop_sequence: number;
  car_no?: string;
  route_name?: string;
  status?: string; // "0" = moving, "1" = completed
  direction?: string;
}

// ── HCCG (新竹市政府) API types ─────────────────────────────

/**
 * Response from GET /WEB/_IMP/API/CleanWeb/getCarLocation?rId=all
 */
export interface HccgApiResponse<T> {
  data: T | null;
  message: string;
  statusCode: number;
}

export interface HccgCarLocation {
  routeId: string;
  carType: string; // "0" = general, "1" = recycle
  address: string;
  carStatus: string; // "0" = in progress, "1" = done
  carNo: string;
  leave: string;
  lon: string;
  updateTime: string; // "YYYY/MM/DD HH:mm:ss"
  lat: string;
  seq: string; // current heading stop sequence
  routeName: string;
  direction: string;
}

export interface HccgCarLocationData {
  total: number;
  car: HccgCarLocation[];
}

/**
 * Response from GET /WEB/_IMP/API/CleanWeb/getPointData?address=
 */
export interface HccgCleanPoint {
  recycleDay: string; // e.g. "1,5" = Mon,Fri
  address: string;
  pointName: string;
  lon: string;
  rcarNo: string;
  holidayMemo: string;
  routeName: string;
  taskType: string;
  routeId: string;
  pointId: string;
  carNo: string;
  district: string; // "3" = 香山區
  estimate: string;
  historyTime: string;
  time: string; // e.g. "12:46~12:47"
  attr: string;
  trashDay: string; // e.g. "1,2,4,5,6"
  seq: string;
  lat: string;
  status: string;
}

export interface HccgCleanPointData {
  total: number;
  cleanPoint: HccgCleanPoint[];
}

/**
 * Response from GET /WEB/_IMP/API/CleanWeb/getRouteData
 */
export interface HccgRoute {
  recycleDay: string;
  routeId: string;
  drivername: string;
  carno: string;
  carNo: string;
  mdrivername: string;
  rcarNo: string;
  gname: string;
  trashDay: string; // e.g. "1,2,4,5,6"
  routeName: string;
}

export interface HccgRouteData {
  total: number;
  route: HccgRoute[];
}

// ── ETA types ────────────────────────────────────────────────

export interface EtaResult {
  found: boolean;
  routeId?: string;
  routeName?: string;
  nearestStopName?: string;
  nearestStopAddress?: string;
  stopLat?: number;
  stopLng?: number;
  userLat?: number;
  userLng?: number;
  etaMinutes?: number;
  carNo?: string;
  truckLat?: number;
  truckLng?: number;
  message: string;
  scheduledTime?: string;
}

// ── LINE Event types (minimal, extends @line/bot-sdk) ────────

export interface LineLocationMessage {
  type: "location";
  title: string;
  address: string;
  latitude: number;
  longitude: number;
}
