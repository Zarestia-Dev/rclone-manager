#!/bin/bash
exec {exec_path} --send-to-remote "{remote}" --send-to-path "{path}" "$@"
