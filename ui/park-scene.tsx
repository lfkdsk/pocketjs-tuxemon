import { For, type Component } from "solid-js";
import { Text, View } from "@pocketjs/framework/components";

import {
  PARK_SUMMARY_TOUCH_CLOSE,
  type ParkSummarySceneState,
} from "../battle/scenes.ts";
import type { BattleSceneViewProps } from "../vendor/pocket-rpgkit/src/ui/GameView.tsx";
import { Panel } from "../vendor/pocket-rpgkit/src/ui/Panel.tsx";
import { SceneCanvas } from "./journal-scene.tsx";
import { TUXEMON_UI_THEME as THEME } from "./tuxemon-theme.ts";

function statCell(label: string, value: string, left: number, top: number) {
  return (
    <View
      class="absolute"
      style={{ posType: 1, insetL: left, insetT: top, width: 136, height: 24 }}
    >
      <Text
        class="text-xs"
        style={{ posType: 1, insetL: 0, insetT: 0, width: 108, height: 14, lineHeight: 13, textColor: THEME.dim }}
      >
        {label}
      </Text>
      <Text
        class="text-sm"
        style={{ posType: 1, insetL: 109, insetT: 0, width: 27, height: 17, lineHeight: 15, textAlign: 2, textColor: THEME.ink }}
      >
        {value}
      </Text>
    </View>
  );
}

export const TuxemonParkSummaryScene: Component<BattleSceneViewProps> = (props) => {
  const state = (): ParkSummarySceneState => props.state as unknown as ParkSummarySceneState;
  const percentage = () => `${Math.round(state().successRate * 100)}%`;
  const close = () => props.onSelectIndex?.(PARK_SUMMARY_TOUCH_CLOSE);

  return (
    <SceneCanvas {...props} debugName="tux-park-summary-scene">
      <Text
        class="text-lg"
        style={{ posType: 1, insetL: 18, insetT: 8, width: 444, height: 25, lineHeight: 22, textAlign: 1, textColor: THEME.accent }}
        debugName="park-summary-title"
      >
        {state().labels.title}
      </Text>

      <Panel
        theme={THEME}
        style={{ posType: 1, insetL: 18, insetT: 35, width: 444, height: 62 }}
        debugName="park-summary-stats"
      >
        {statCell(state().labels.uniqueSeen, String(state().uniqueSeen), 10, 8)}
        {statCell(state().labels.attempts, String(state().attempts), 151, 8)}
        {statCell(state().labels.successful, String(state().successfulCaptures), 292, 8)}
        {statCell(state().labels.failed, String(state().failedAttempts), 10, 32)}
        {statCell(state().labels.successRate, percentage(), 151, 32)}
      </Panel>

      <Panel
        theme={THEME}
        style={{ posType: 1, insetL: 18, insetT: 104, width: 216, height: 118 }}
        debugName="park-summary-sightings"
      >
        <Text
          class="text-sm"
          style={{ posType: 1, insetL: 10, insetT: 7, width: 196, height: 18, lineHeight: 16, textColor: THEME.accent }}
        >
          {state().labels.topSightings}
        </Text>
        {state().sightings.length === 0 ? (
          <Text
            class="text-xs"
            style={{ posType: 1, insetL: 10, insetT: 31, width: 196, height: 16, lineHeight: 14, textColor: THEME.dim }}
          >
            {state().labels.none}
          </Text>
        ) : (
          <For each={state().sightings}>
            {(entry, index) => (
              <Text
                class="text-xs"
                style={{ posType: 1, insetL: 10, insetT: 27 + index() * 16, width: 196, height: 16, lineHeight: 14, textColor: THEME.ink }}
                debugName="park-summary-sighting-row"
              >
                {`${entry.name} · ${state().labels.seenTimes(entry.count)}`}
              </Text>
            )}
          </For>
        )}
      </Panel>

      <Panel
        theme={THEME}
        style={{ posType: 1, insetL: 246, insetT: 104, width: 216, height: 118 }}
        debugName="park-summary-highlights"
      >
        <Text
          class="text-sm"
          style={{ posType: 1, insetL: 10, insetT: 7, width: 196, height: 18, lineHeight: 16, textColor: THEME.accent }}
        >
          {state().labels.highlights}
        </Text>
        {state().highlights.length === 0 ? (
          <Text
            class="text-xs"
            style={{ posType: 1, insetL: 10, insetT: 31, width: 196, height: 16, lineHeight: 14, textColor: THEME.dim }}
          >
            {state().labels.none}
          </Text>
        ) : (
          <For each={state().highlights}>
            {(entry, index) => (
              <Text
                class="text-xs"
                style={{ posType: 1, insetL: 10, insetT: 27 + index() * 16, width: 196, height: 16, lineHeight: 14, textColor: THEME.ink }}
                debugName="park-summary-highlight-row"
              >
                {`${entry.name} · ${state().labels.averageTurns(entry.averageTurnsRemaining)}`}
              </Text>
            )}
          </For>
        )}
      </Panel>

      <View
        class="absolute items-center justify-center"
        style={{ posType: 1, insetL: 115, insetT: 230, width: 250, height: 32, bgColor: THEME.accent, borderWidth: 2, borderColor: THEME.paper }}
        focusable={props.active && props.onSelectIndex !== undefined}
        onPress={close}
        debugName="park-summary-close"
      >
        <Text
          class="text-sm"
          style={{ width: 232, height: 19, lineHeight: 17, textAlign: 1, textColor: THEME.paper }}
        >
          {state().labels.close}
        </Text>
      </View>
    </SceneCanvas>
  );
};
