# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0
#
# Onward zsh shell integration — `.zshenv` half of the ZDOTDIR wrapper.
#
# zsh's startup-file order for an interactive login shell is:
#   1. /etc/zshenv
#   2. $ZDOTDIR/.zshenv      ← THIS FILE
#   3. /etc/zprofile
#   4. $ZDOTDIR/.zprofile    ← .zprofile in this wrapper
#   5. /etc/zshrc
#   6. $ZDOTDIR/.zshrc       ← .zshrc in this wrapper
#   7. /etc/zlogin
#   8. $ZDOTDIR/.zlogin      ← .zlogin in this wrapper
#
# Because pty-manager sets ZDOTDIR to this wrapper directory, zsh resolves
# steps 2/4/6/8 against THIS dir. If we did not provide a `.zshenv` /
# `.zprofile` / `.zlogin` here, those user-level files would be silently
# skipped — and on macOS, `~/.zprofile` is the conventional home for
# `eval "$(brew shellenv)"`, asdf/mise/nvm init, and PATH setup, so missing
# them breaks Homebrew toolchains in Onward terminals.
#
# Each file in the wrapper temporarily flips ZDOTDIR back to USER_ZDOTDIR
# (set by pty-manager before the spawn), sources the user's matching real
# file, and flips ZDOTDIR back to the wrapper so subsequent zsh startup
# steps continue to find OUR files. Crucially we do NOT unset USER_ZDOTDIR
# until the last file in the chain (.zlogin) — the in-between wrappers
# still need it.

if [[ -n "${USER_ZDOTDIR:-}" && -f "${USER_ZDOTDIR}/.zshenv" ]]; then
  __ONWARD_ZDOTDIR_WRAPPER="$ZDOTDIR"
  ZDOTDIR="$USER_ZDOTDIR"
  source "$ZDOTDIR/.zshenv"
  ZDOTDIR="$__ONWARD_ZDOTDIR_WRAPPER"
  unset __ONWARD_ZDOTDIR_WRAPPER
fi
