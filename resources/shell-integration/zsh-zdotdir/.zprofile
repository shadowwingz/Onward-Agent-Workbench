# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0
#
# Onward zsh shell integration — `.zprofile` half of the ZDOTDIR wrapper.
# See `.zshenv` in this directory for the full design rationale; in short,
# zsh resolves `$ZDOTDIR/.zprofile` against THIS wrapper, so without this
# file the user's `~/.zprofile` is never sourced and macOS Homebrew /
# asdf / mise PATH initialisation is silently dropped.

if [[ -n "${USER_ZDOTDIR:-}" && -f "${USER_ZDOTDIR}/.zprofile" ]]; then
  __ONWARD_ZDOTDIR_WRAPPER="$ZDOTDIR"
  ZDOTDIR="$USER_ZDOTDIR"
  source "$ZDOTDIR/.zprofile"
  ZDOTDIR="$__ONWARD_ZDOTDIR_WRAPPER"
  unset __ONWARD_ZDOTDIR_WRAPPER
fi
