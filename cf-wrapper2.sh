#!/bin/bash
echo "ARGS: $@" > wrapper_args.log
exec /Users/user298993/Library/Caches/camoufox/Camoufox.app/Contents/MacOS/camoufox "$@"
