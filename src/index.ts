import { start } from "./gameframe";

export type { MugonContext, MugonEvents, MugonMessage } from "./gameframe";
export { Channel } from "./protocol";
export type {
  NetworkRole,
  Player,
  PlayerCharacter,
  SettingValue,
} from "./protocol";

export const Mugon = { start };
