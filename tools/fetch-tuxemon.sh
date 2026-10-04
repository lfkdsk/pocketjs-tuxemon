#!/bin/sh
# tools/fetch-tuxemon.sh — fetch the Tuxemon source the importer reads.
#
#   sh tools/fetch-tuxemon.sh [dir]     # default: .tuxemon-src
#
# A blobless, sparse checkout of Tuxemon pinned to TUXEMON_COMMIT: maps,
# databases, translations, graphics, sprites, animations, sounds and the
# Python engine (for action/condition semantics). Fonts and docs are left
# out. Music is excluded except for the 24 tracks referenced by imported map
# and environment content; everything else under music/ stays out. Set
# TUXEMON_SRC to point the importer elsewhere.
set -eu
TUXEMON_COMMIT=9e6258ff
dir=${1:-.tuxemon-src}
if [ ! -d "$dir/.git" ]; then
  git clone -q --filter=blob:none --no-checkout https://github.com/Tuxemon/Tuxemon.git "$dir"
fi
cd "$dir"
git sparse-checkout init --no-cone
# Imported-content music: exclude the whole music tree, then re-include the
# exact files resolved by tools/music-catalog.ts. Keep this list in sync with
# the pinned content-catalogue test.
cat > .git/info/sparse-checkout <<'EOF'
/*
!/mods/tuxemon/music/**
/mods/tuxemon/music/All of Us.ogg
/mods/tuxemon/music/Chibi Ninja.ogg
/mods/tuxemon/music/Come and Find Me.ogg
/mods/tuxemon/music/Digital Native.ogg
/mods/tuxemon/music/JRPG_royalCourt_loop.ogg
/mods/tuxemon/music/JRPG_town_loop.ogg
/mods/tuxemon/music/JRPG_docks_loop.ogg
/mods/tuxemon/music/JRPG_mysticIsle.ogg
/mods/tuxemon/music/JRPG_mysticIsle_reverse.ogg
/mods/tuxemon/music/JRPG_princess.ogg
/mods/tuxemon/music/peasant_kingdom.ogg
/mods/tuxemon/music/back34.mp3
/mods/tuxemon/music/Jester Theme.mp3
/mods/tuxemon/music/stand_with_us.ogg
/mods/tuxemon/music/taking_poison.ogg
/mods/tuxemon/music/TheAdventureBegins8bitRemix.ogg
/mods/tuxemon/music/JRPG-OSTR2/
/mods/tuxemon/music/JRPG-OSTR2/10 - The Empire.ogg
/mods/tuxemon/music/JRPG-OSTR2/07 - Town.ogg
/mods/tuxemon/music/JRPG-OSTR2/18 - Nighttide Waltz.ogg
/mods/tuxemon/music/JRPGCollection/
/mods/tuxemon/music/JRPGCollection/ogg/
/mods/tuxemon/music/JRPGCollection/ogg/JRPG_battle_loop.ogg
/mods/tuxemon/music/JRPGCollection/ogg/JRPG_fields_loop.ogg
/mods/tuxemon/music/JRPGCollection/ogg/JRPG_gameOver.ogg
/mods/tuxemon/music/JRPGCollection2/
/mods/tuxemon/music/JRPGCollection2/ogg/
/mods/tuxemon/music/JRPGCollection2/ogg/JRPG_discovery.ogg
/mods/tuxemon/music/JRPGCollection2/ogg/JRPG_winBattleBoss.ogg
!/mods/tuxemon/font/
!/docs/
EOF
git checkout -q "$TUXEMON_COMMIT"
git log --oneline -1
