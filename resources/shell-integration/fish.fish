# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0
#
# Onward fish shell integration. Auto-loaded via the
# `XDG_DATA_DIRS=<our>:$XDG_DATA_DIRS` injection pty-manager performs at
# spawn — fish picks up the `vendor_conf.d` entry under our data dir.
#
# Emits both OSC 633 (VS Code-proprietary) and OSC 7 (cross-emulator
# standard) on every fish_prompt event.

if test "$ONWARD_SHELL_INTEGRATION" = "0"
    exit 0
end

function __onward_emit_cwd --on-event fish_prompt
    set -l pwd_url (string replace -a ' ' '%20' $PWD)
    printf '\e]633;P;Cwd=%s\a\e]7;file://%s%s\e\\' $PWD $hostname $pwd_url
end
