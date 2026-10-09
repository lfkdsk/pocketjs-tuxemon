import { Show, type Component } from "solid-js";
import { Text, View } from "@pocketjs/framework/components";

import {
  RADIO_TOUCH_BROADCAST_NEXT,
  RADIO_TOUCH_PLAY,
  RADIO_TOUCH_RETURN,
  RADIO_TOUCH_TUNE_DOWN,
  RADIO_TOUCH_TUNE_UP,
  radioSelectedStation,
  radioSignalLabel,
  type RadioSceneState,
} from "../battle/radio-scenes.ts";
import type { BattleSceneViewProps } from "../vendor/pocket-rpgkit/src/ui/GameView.tsx";
import { Panel } from "../vendor/pocket-rpgkit/src/ui/Panel.tsx";
import { SceneCanvas, wrapped } from "./journal-scene.tsx";
import { TUXEMON_UI_THEME } from "./tuxemon-theme.ts";

const THEME = TUXEMON_UI_THEME;

function TouchButton(props: {
  active: boolean;
  onSelectIndex?: (index: number) => void;
  index: number;
  left: number;
  top: number;
  width: number;
  label: string;
  accent?: boolean;
  debugName: string;
}) {
  return (
    <View
      class="absolute items-center justify-center"
      style={{
        posType: 1,
        insetL: props.left,
        insetT: props.top,
        width: props.width,
        height: 32,
        bgColor: props.accent ? THEME.accent : THEME.paper,
        borderWidth: 2,
        borderColor: props.accent ? THEME.paper : THEME.border,
      }}
      focusable={props.active && props.onSelectIndex !== undefined}
      onPress={() => props.onSelectIndex?.(props.index)}
      debugName={props.debugName}
    >
      <Text
        class="text-sm"
        style={{
          height: 20,
          lineHeight: 18,
          textColor: props.accent ? THEME.paper : THEME.ink,
        }}
      >
        {props.label}
      </Text>
    </View>
  );
}

function stationLabel(state: Readonly<RadioSceneState>): string {
  const selected = radioSelectedStation(state);
  if (!selected || selected.slug === state.fallbackStation) return state.labels.tuningStatic;
  return state.labels.tuningStation.replace("{station}", selected.label);
}

function broadcastStationLabel(state: Readonly<RadioSceneState>): string {
  const selected = state.stations.find((entry) => entry.slug === state.broadcastStationSlug);
  return selected?.label ?? state.labels.tuningStatic;
}

export const TuxemonRadioScene: Component<BattleSceneViewProps> = (props) => {
  const state = (): RadioSceneState => props.state as unknown as RadioSceneState;
  const strengthWidth = () => Math.round(292 * Math.max(0, Math.min(100, state().signalStrength)) / 100);
  const message = () => state().broadcastDialogue[state().broadcastCursor] ?? state().labels.tuningStatic;

  return (
    <SceneCanvas {...props} debugName="tux-radio-scene">
      <View
        class="absolute"
        style={{ posType: 1, insetL: 0, insetT: 0, width: 480, height: 272, bgColor: "#101a2cff" }}
      />
      <Text
        class="text-lg"
        style={{ posType: 1, insetL: 18, insetT: 10, width: 260, height: 24, lineHeight: 21, textColor: THEME.accent }}
        debugName="radio-title"
      >
        {state().labels.title}
      </Text>
      <Text
        class="text-xs"
        style={{ posType: 1, insetR: 18, insetT: 14, width: 170, height: 16, lineHeight: 14, textColor: THEME.dim }}
      >
        {state().labels.hint}
      </Text>

      <Show
        when={state().phase === "broadcast"}
        fallback={
          <>
            <Panel
              theme={THEME}
              style={{ posType: 1, insetL: 18, insetT: 40, width: 444, height: 158 }}
              debugName="radio-tuner-panel"
            >
              <Text
                class="text-2xl"
                style={{ posType: 1, insetL: 104, insetT: 6, width: 206, height: 44, lineHeight: 39, textColor: THEME.accent }}
                debugName="radio-frequency"
              >
                {state().frequency.toFixed(1)}
              </Text>
              <Text
                class="text-sm"
                style={{ posType: 1, insetL: 285, insetT: 25, width: 60, height: 18, lineHeight: 16, textColor: THEME.dim }}
              >
                MHz
              </Text>
              <Text
                class="text-sm"
                style={{ posType: 1, insetL: 28, insetT: 53, width: 376, height: 20, lineHeight: 18, textColor: THEME.accent }}
                debugName="radio-station-label"
              >
                {stationLabel(state())}
              </Text>

              <View
                class="absolute"
                style={{ posType: 1, insetL: 70, insetT: 82, width: 292, height: 8, bgColor: THEME.border }}
                debugName="radio-band"
              >
                <View
                  class="absolute"
                  style={{
                    posType: 1,
                    insetL: Math.round(286 * (state().frequency - state().minFrequency) /
                      (state().maxFrequency - state().minFrequency)),
                    insetT: -4,
                    width: 6,
                    height: 16,
                    bgColor: THEME.accent,
                  }}
                  debugName="radio-dial-marker"
                />
              </View>
              <Text
                class="text-xs"
                style={{ posType: 1, insetL: 65, insetT: 94, width: 48, height: 15, lineHeight: 13, textColor: THEME.dim }}
              >
                {state().minFrequency.toFixed(1)}
              </Text>
              <Text
                class="text-xs"
                style={{ posType: 1, insetR: 63, insetT: 94, width: 52, height: 15, lineHeight: 13, textColor: THEME.dim }}
              >
                {state().maxFrequency.toFixed(1)}
              </Text>

              <Text
                class="text-xs"
                style={{ posType: 1, insetL: 70, insetT: 116, width: 130, height: 16, lineHeight: 14, textColor: THEME.dim }}
              >
                {`${state().labels.signal}: ${radioSignalLabel(state())} (${state().signalStrength}%)`}
              </Text>
              <View
                class="absolute"
                style={{ posType: 1, insetL: 70, insetT: 136, width: 292, height: 8, bgColor: THEME.border }}
                debugName="radio-signal-track"
              >
                <View
                  class="absolute"
                  style={{ posType: 1, insetL: 0, insetT: 0, width: strengthWidth(), height: 8, bgColor: THEME.accent }}
                  debugName="radio-signal-fill"
                />
              </View>
            </Panel>

            <TouchButton
              active={props.active}
              onSelectIndex={props.onSelectIndex}
              index={RADIO_TOUCH_TUNE_DOWN}
              left={18}
              top={210}
              width={84}
              label="− 0.1"
              debugName="radio-tune-down"
            />
            <TouchButton
              active={props.active}
              onSelectIndex={props.onSelectIndex}
              index={RADIO_TOUCH_TUNE_UP}
              left={112}
              top={210}
              width={84}
              label="+ 0.1"
              debugName="radio-tune-up"
            />
            <TouchButton
              active={props.active}
              onSelectIndex={props.onSelectIndex}
              index={RADIO_TOUCH_PLAY}
              left={206}
              top={210}
              width={152}
              label={state().labels.play}
              accent
              debugName="radio-play"
            />
            <TouchButton
              active={props.active}
              onSelectIndex={props.onSelectIndex}
              index={RADIO_TOUCH_RETURN}
              left={368}
              top={210}
              width={94}
              label={state().labels.back}
              debugName="radio-return"
            />
            <Text
              class="text-xs"
              style={{ posType: 1, insetL: 20, insetT: 250, width: 440, height: 15, lineHeight: 13, textColor: THEME.dim }}
            >
              {`${state().labels.tuner}: ←/→   A: ${state().labels.play}   B: ${state().labels.back}`}
            </Text>
          </>
        }
      >
        <Panel
          theme={THEME}
          style={{ posType: 1, insetL: 34, insetT: 52, width: 412, height: 170 }}
          debugName="radio-broadcast-panel"
        >
          <Text
            class="text-lg"
            style={{ posType: 1, insetL: 16, insetT: 12, width: 360, height: 24, lineHeight: 21, textColor: THEME.accent }}
            debugName="radio-broadcast-station"
          >
            {broadcastStationLabel(state())}
          </Text>
          <Text
            class="text-sm"
            style={{ posType: 1, insetL: 16, insetT: 50, width: 380, height: 82, lineHeight: 19, textColor: THEME.ink }}
            debugName="radio-broadcast-text"
          >
            {wrapped(message(), 48, 4)}
          </Text>
          <Text
            class="text-xs"
            style={{ posType: 1, insetR: 14, insetB: 10, width: 90, height: 15, lineHeight: 13, textColor: THEME.dim }}
          >
            {`${state().broadcastCursor + 1}/${state().broadcastDialogue.length}`}
          </Text>
        </Panel>
        <TouchButton
          active={props.active}
          onSelectIndex={props.onSelectIndex}
          index={RADIO_TOUCH_BROADCAST_NEXT}
          left={164}
          top={230}
          width={152}
          label={state().labels.next}
          accent
          debugName="radio-broadcast-next"
        />
      </Show>
    </SceneCanvas>
  );
};
