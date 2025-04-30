#!/usr/bin/env python3
import sys
import io
import os
import subprocess
import tempfile
from PIL import Image, ImageOps

mode = sys.argv[1] if len(sys.argv) > 1 else 'static'
data = sys.stdin.buffer.read()

# Create temp files
with tempfile.NamedTemporaryFile(delete=False, suffix=".dat") as in_f:
    in_path = in_f.name
    in_f.write(data)
out_f = tempfile.NamedTemporaryFile(delete=False, suffix=".webp")
out_path = out_f.name
out_f.close()

try:
    # Static sticker
    if mode == 'static':
        img = Image.open(in_path).convert('RGBA')
        # Fit into 512x512 exactly
        img = ImageOps.fit(img, (512,512), Image.LANCZOS, centering=(0.5,0.5))
        size_limit = 1024 * 1024  # 1 MB
        # Try decreasing quality levels
        for quality in (80, 60, 40, 20):
            buf = io.BytesIO()
            img.save(buf, format='WEBP', quality=quality, method=6)
            data_out = buf.getvalue()
            if len(data_out) <= size_limit:
                sys.stdout.buffer.write(data_out)
                break
        else:
            # fallback to smaller resolution
            img_small = img.resize((256,256), Image.LANCZOS)
            buf = io.BytesIO()
            img_small.save(buf, format='WEBP', quality=20, method=6)
            sys.stdout.buffer.write(buf.getvalue())

    # Animated sticker
    else:
        size_limit = 1024 * 1024  # 1 MB
        # First pass: 512x512, max 6 seconds
        cmd = [
            'ffmpeg', '-y',
            '-i', in_path,
            '-t', '6',
            '-vf', 'fps=10,scale=512:512:flags=lanczos',
            '-loop', '0',
            '-vcodec', 'libwebp',
            out_path
        ]
        subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        # If too large, fallback to 256x256
        if os.path.getsize(out_path) > size_limit:
            cmd[4] = 'scale=256:256:flags=lanczos'  # replace scale filter
            subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        with open(out_path, 'rb') as f:
            sys.stdout.buffer.write(f.read())

finally:
    # Cleanup
    try: os.remove(in_path)
    except: pass
    try: os.remove(out_path)
    except: pass
