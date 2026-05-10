# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0
#
# Onward zsh shell integration — `.zlogin` half of the ZDOTDIR wrapper.
# Final file in zsh's login startup chain. After we source the user's
# `.zlogin` we drop USER_ZDOTDIR — the wrapper has now finished its job
# and leaving the env var around would leak into user processes.

if [[ -n "${USER_ZDOTDIR:-}" && -f "${USER_ZDOTDIR}/.zlogin" ]]; then
  __ONWARD_ZDOTDIR_WRAPPER="$ZDOTDIR"
  ZDOTDIR="$USER_ZDOTDIR"
  source "$ZDOTDIR/.zlogin"
  ZDOTDIR="$__ONWARD_ZDOTDIR_WRAPPER"
  unset __ONWARD_ZDOTDIR_WRAPPER
fi

unset USER_ZDOTDIR
