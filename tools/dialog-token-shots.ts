// The representative dialog-token shots. Each one is a REAL imported event
// on a REAL map; tools/render-dialog-tokens.ts and the production-path test
// both open it through the production bundle (see dialog-token-drive.ts).
//
// Template coverage:
//   {v:}            scoreboard-en   (Chad 0 vs Brad 0 — the B1 string values)
//   {x:money}+{name} wallet-en/zh   (Red's wallet: $ 500 / Red的钱包： $ 500)
//   {x:today}       today-en        (April 27 — the 4-27 date gate, cutscene)
//   {x:map_desc}    mapdesc-*       (timber 粮, lion 尺 — the B2 risk glyphs)
//   monster_0_level monster-*-en    (Lv 7 …)
//   monster_0_name  monster-nut-en  (no nickname -> species name)
//                   monster-av8r-en (special species name -> AV8R)
//                   monster-nick-en (nickname wins -> Sparky)

import type { DialogShot } from "./dialog-token-drive.ts";

export const DIALOG_SHOTS: readonly DialogShot[] = [
  {
    slug: "scoreboard-en",
    lang: "en_US",
    mapId: "spyder_leather_gym",
    eventId: "e001_board_r002",
    trigger: "action",
    stand: { x: 6, y: 3, dir: "up" },
    expect: "Chad 0 vs Brad 0",
  },
  {
    slug: "wallet-en",
    lang: "en_US",
    mapId: "spyder_cotton_artshop",
    eventId: "e008_pay_up_r002",
    trigger: "touch",
    stand: { x: 0, y: 10, dir: "up" },
    expect: "Red's wallet: $ 500",
    fastForward: true,
  },
  {
    slug: "wallet-zh",
    lang: "zh_CN",
    mapId: "spyder_cotton_artshop",
    eventId: "e008_pay_up_r002",
    trigger: "touch",
    stand: { x: 0, y: 10, dir: "up" },
    expect: "Red的钱包： $ 500",
    fastForward: true,
  },
  {
    slug: "today-en",
    lang: "en_US",
    mapId: "maple_bedroom",
    eventId: "e006_stop_27apr_r003",
    trigger: "touch",
    stand: { x: 8, y: 5, dir: "up" },
    seedDate: { year: 2024, month: 4, day: 27 },
    expect: "April 27",
    fastForward: true,
  },
  {
    slug: "mapdesc-timber-en",
    lang: "en_US",
    mapId: "spyder_timber_town",
    eventId: "e016_sign_timber_town_r021",
    trigger: "action",
    stand: { x: 6, y: 2, dir: "up" },
    expect: "Breadbasket of Fondant",
  },
  {
    slug: "mapdesc-timber-zh",
    lang: "zh_CN",
    mapId: "spyder_timber_town",
    eventId: "e016_sign_timber_town_r021",
    trigger: "action",
    stand: { x: 6, y: 2, dir: "up" },
    expect: "粮",
  },
  {
    slug: "mapdesc-lion-en",
    lang: "en_US",
    mapId: "eclipse_lion_mountain_low",
    eventId: "e016_welcome_sign_r009",
    trigger: "action",
    stand: { x: 12, y: 9, dir: "up" },
    expect: "3,776 m (12,388 ft)",
  },
  {
    slug: "mapdesc-lion-zh",
    lang: "zh_CN",
    mapId: "eclipse_lion_mountain_low",
    eventId: "e016_welcome_sign_r009",
    trigger: "action",
    stand: { x: 12, y: 9, dir: "up" },
    expect: "尺",
  },
  {
    slug: "monster-nut-en",
    lang: "en_US",
    mapId: "sphalian_town_house",
    eventId: "e002_watch_tv_r003",
    trigger: "action",
    stand: { x: 1, y: 6, dir: "right" },
    seedParty: { slug: "nut", level: 7 },
    expect: "Lv 7 Nut",
  },
  {
    slug: "monster-av8r-en",
    lang: "en_US",
    mapId: "sphalian_town_house",
    eventId: "e002_watch_tv_r003",
    trigger: "action",
    stand: { x: 1, y: 6, dir: "right" },
    seedParty: { slug: "av8r", level: 7 },
    expect: "Lv 7 AV8R",
  },
  {
    slug: "monster-nick-en",
    lang: "en_US",
    mapId: "sphalian_town_house",
    eventId: "e002_watch_tv_r003",
    trigger: "action",
    stand: { x: 1, y: 6, dir: "right" },
    seedParty: { slug: "nut", level: 7, nickname: "Sparky" },
    expect: "Lv 7 Sparky",
  },
];
