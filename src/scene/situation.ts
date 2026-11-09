import type { Group, Vector3 } from 'three';
import type { Photometry } from './photometry';

export type Weather = 'sunny' | 'overcast' | 'night';

export const WEATHER_LABELS: Record<Weather, string> = {
  sunny: '晴れた昼',
  overcast: '曇りの昼',
  night: '夜',
};

/** 夜空の種類: 都市 (光害の空、月なし) / 郊外 (月と星) */
export type NightSky = 'urban' | 'rural';

/** シチュエーション側の光源計算に渡す屋外の状態 */
export interface OutdoorConditions {
  weather: Weather;
  /** 直射光 (太陽 or 月) の法線照度 [lx]。0 なら直射なし */
  directLux: number;
  /** 直射光が来る方向 (光源へ向かう単位ベクトル) */
  directDir: Vector3;
  /** 水平方向に見える屋外 (空と地面) の平均輝度 [cd/m²] */
  horizontalLuminance: number;
}

export interface CameraBounds {
  min: Vector3;
  max: Vector3;
  /** 地面の高さ [m]。カメラはこれより 0.3m 以上上に保つ */
  ground?: (x: number, z: number) => number;
}

export interface Situation {
  root: Group;
  bounds: CameraBounds;
  start: { position: Vector3; yaw: number; pitch: number; focus: number; focal: number };
  /** 直射光の影を計算する範囲 (中心と半径 [m]) */
  shadow: { center: Vector3; extent: number };
  nightSky: NightSky;
  /** 自前の光源・発光体の物理値を Photometry に設定する */
  setWeather(c: OutdoorConditions, p: Photometry): void;
  /** 絶対時刻 [s] での動く物体の状態 (露光中のモーションブラーに使う) */
  update(timeSec: number): void;
}

export type SituationKind = 'city' | 'landscape' | 'room';

export const SITUATION_LABELS: Record<SituationKind, string> = {
  city: '屋外: 都市',
  landscape: '屋外: 野山',
  room: '部屋の中',
};
