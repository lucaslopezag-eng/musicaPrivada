import sys
import os
import warnings

if len(sys.argv) < 3:
    print("Usage: python generate_subtitles.py <ffmpeg_executable_path> <audio_file_path>")
    sys.exit(1)

ffmpeg_path = sys.argv[1]

# On Linux, adding to PATH works reliably. On Windows, CreateProcess sometimes ignores it, 
# but if the user installed ffmpeg globally or via Node ffmpeg-static it will be passed here.
# To be absolutely safe, we inject the directory containing the ffmpeg binary into PATH.
ffmpeg_dir = os.path.dirname(ffmpeg_path)
os.environ["PATH"] = ffmpeg_dir + os.pathsep + os.environ.get("PATH", "")

warnings.filterwarnings("ignore")

try:
    import whisper
    import whisper.utils
except ImportError:
    print("whisper not installed")
    sys.exit(1)

audio_path = sys.argv[2]
output_dir = os.path.dirname(audio_path)
base_name = os.path.basename(audio_path)
name_without_ext = os.path.splitext(base_name)[0]
vtt_path = os.path.join(output_dir, name_without_ext + ".vtt")

if os.path.exists(vtt_path):
    print(f"VTT already exists at {vtt_path}")
    sys.exit(0)

print(f"Loading Whisper model (small)...")
# 'small' model has much better accuracy than 'base', especially for non-English
model = whisper.load_model("small") 

print(f"Transcribing {audio_path}...")
# Transcribe without fp16 to avoid warnings on CPU
result = model.transcribe(audio_path, fp16=False, word_timestamps=True)

# Write VTT
print(f"Writing VTT to {output_dir}")
writer = whisper.utils.get_writer("vtt", output_dir)
writer(result, audio_path, {"max_line_width": 40, "max_line_count": 2, "highlight_words": False})

print(f"Successfully generated {vtt_path}")
