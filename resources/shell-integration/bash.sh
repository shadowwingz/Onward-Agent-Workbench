# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0
#
# Onward bash shell integration. Injected via `bash --rcfile <wrapper>`.
# The wrapper sources the user's ~/.bashrc first, then sources this file
# so user prompts / aliases / completions still load normally.
#
# Emits two OSC sequences on every prompt:
#   OSC 633 ; P ; Cwd=<path> BEL    — VS Code-proprietary, primary parser path
#   OSC 7   ; file://host/path ESC\ — cross-emulator standard fallback
#
# Set ONWARD_SHELL_INTEGRATION=0 in the environment to disable.

if [ "${ONWARD_SHELL_INTEGRATION:-1}" = "0" ]; then
  return 0 2>/dev/null
fi

__onward_emit_cwd() {
  local pwd_url="${PWD// /%20}"
  printf '\e]633;P;Cwd=%s\a\e]7;file://%s%s\e\\' "$PWD" "${HOSTNAME:-localhost}" "$pwd_url"
}

# Compose with the user's existing PROMPT_COMMAND. Avoid double-registration
# when the shell rcfile is sourced more than once (some plugin managers do).
case ":${PROMPT_COMMAND:-}:" in
  *":__onward_emit_cwd:"*) ;;
  *)
    if [ -n "${PROMPT_COMMAND:-}" ]; then
      PROMPT_COMMAND="__onward_emit_cwd; ${PROMPT_COMMAND}"
    else
      PROMPT_COMMAND="__onward_emit_cwd"
    fi
    ;;
esac
export PROMPT_COMMAND
