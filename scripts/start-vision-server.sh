#!/bin/bash
set -e

BASE_DIR="$(pwd)/models"
MODEL_DIR="${BASE_DIR}/MiniCPM-V-2_6"
LLAMA_CPP_DIR="${BASE_DIR}/llama.cpp"

if [ ! -d "$LLAMA_CPP_DIR" ]; then
    echo "ERROR: llama.cpp not found at $LLAMA_CPP_DIR."
    echo "Please run download_and_convert_minicpm.sh first."
    exit 1
fi

if [ ! -f "${MODEL_DIR}/ggml-model-Q4_K_M.gguf" ] || [ ! -f "${MODEL_DIR}/mmproj-model-f16.gguf" ]; then
    echo "ERROR: GGUF models not found in $MODEL_DIR."
    echo "Please ensure the download script completed successfully."
    exit 1
fi

# Build llama-server if not already built
if [ ! -f "${LLAMA_CPP_DIR}/build/bin/llama-server" ] && [ ! -f "${LLAMA_CPP_DIR}/llama-server" ]; then
    echo "Compiling llama-server..."
    cd "$LLAMA_CPP_DIR"
    cmake -B build
    cmake --build build --config Release -j 4
    cd - > /dev/null
fi

SERVER_BIN="${LLAMA_CPP_DIR}/build/bin/llama-server"
if [ ! -f "$SERVER_BIN" ]; then
    # Fallback for some CMake setups where binaries are output in the root build dir
    SERVER_BIN="${LLAMA_CPP_DIR}/llama-server"
fi

if [ ! -f "$SERVER_BIN" ]; then
    echo "ERROR: Failed to find compiled llama-server executable."
    exit 1
fi

echo "Starting local MiniCPM Vision Server on port 8080..."
"$SERVER_BIN" \
    -m "${MODEL_DIR}/ggml-model-Q4_K_M.gguf" \
    --mmproj "${MODEL_DIR}/mmproj-model-f16.gguf" \
    --port 8080 \
    --host 127.0.0.1 \
    -c 4096 \
    -ngl 99 \
    --threads 4
