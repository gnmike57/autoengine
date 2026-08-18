#!/bin/bash
set -e

# Default settings
REPO_ID="openbmb/MiniCPM-V-2_6-gguf"
BASE_DIR="$(pwd)/models"
MODEL_DIR="${BASE_DIR}/MiniCPM-V-2_6"
VENV_DIR="${BASE_DIR}/venv"
LLAMA_CPP_DIR="${BASE_DIR}/llama.cpp"

echo "=== MiniCPM Download Script (GGUF direct) ==="
echo "Target Repo: $REPO_ID"
echo "Base Directory: $BASE_DIR"

mkdir -p "$BASE_DIR"
mkdir -p "$MODEL_DIR"

# Step 1: Python environment setup
if [ ! -d "$VENV_DIR" ]; then
    echo "Creating Python virtual environment..."
    python3 -m venv "$VENV_DIR"
fi

source "$VENV_DIR/bin/activate"
pip install -U pip huggingface_hub

# Step 2: Download Model
echo "Downloading pre-converted GGUF files..."
python3 -c "
from huggingface_hub import hf_hub_download
import os

repo_id = '$REPO_ID'
local_dir = '$MODEL_DIR'

files_to_download = [
    'ggml-model-Q4_K_M.gguf',
    'mmproj-model-f16.gguf'
]

for filename in files_to_download:
    print(f'Downloading {filename}...')
    hf_hub_download(
        repo_id=repo_id,
        filename=filename,
        local_dir=local_dir,
        local_dir_use_symlinks=False
    )
"

# Step 3: Clone llama.cpp if not present
if [ ! -d "$LLAMA_CPP_DIR" ]; then
    echo "Cloning llama.cpp..."
    git clone https://github.com/ggml-org/llama.cpp "$LLAMA_CPP_DIR"
fi

echo "=== Download Complete ==="
echo "Models are available at:"
echo "LLM: ${MODEL_DIR}/ggml-model-Q4_K_M.gguf"
echo "Projector: ${MODEL_DIR}/mmproj-model-f16.gguf"
