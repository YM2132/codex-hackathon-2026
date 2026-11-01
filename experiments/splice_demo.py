"""Insert each existing test clip at 7.5s in the 15-second base video."""
import argparse
import json
from pathlib import Path
import subprocess


ROOT = Path(__file__).resolve().parents[1]


def build(base: Path, insert: Path, audio: Path, start: int, end: int,
          output: Path) -> dict:
    duration = end - start
    normalize_video = (
        "setpts=PTS-STARTPTS,fps=30,scale=1280:720:force_original_aspect_ratio=decrease,"
        "pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p"
    )
    normalize_audio = "asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo"
    graph = ";".join([
        "[0:v]split=2[headv][tailv]",
        "[0:a]asplit=2[heada][taila]",
        f"[headv]trim=start=0:end=7.5,{normalize_video},trim=end_frame=225[v0]",
        f"[heada]atrim=start=0:end=7.5,{normalize_audio},apad,atrim=duration=7.5[a0]",
        f"[1:v]trim=start=0:end={duration},{normalize_video},trim=end_frame={duration*30}[v1]",
        f"[2:a]atrim=start={start-53}:end={end-53},{normalize_audio},apad,atrim=duration={duration}[a1]",
        f"[tailv]trim=start=7.5:end=15,{normalize_video},trim=end_frame=225[v2]",
        f"[taila]atrim=start=7.5:end=15,{normalize_audio},apad,atrim=duration=7.5[a2]",
        "[v0][a0][v1][a1][v2][a2]concat=n=3:v=1:a=1[v][a]",
    ])
    command = [
        "ffmpeg", "-hide_banner", "-loglevel", "warning", "-nostdin", "-n",
        "-i", str(base), "-i", str(insert), "-i", str(audio),
        "-filter_complex", graph, "-map", "[v]", "-map", "[a]",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
        "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", str(output),
    ]
    with output.with_suffix(".log").open("w") as log:
        subprocess.run(command, check=True, stdout=log, stderr=subprocess.STDOUT)
    probe = subprocess.run([
        "ffprobe", "-v", "error", "-show_entries", "format=duration:stream=codec_name,codec_type,width,height,r_frame_rate",
        "-of", "json", str(output),
    ], check=True, capture_output=True, text=True)
    metadata = json.loads(probe.stdout)
    if abs(float(metadata["format"]["duration"]) - (15 + duration)) > 0.01:
        raise RuntimeError(f"Unexpected output duration for {output}")
    return {
        "file": output.name, "duration_seconds": 15 + duration,
        "base_source": "https://www.youtube.com/watch?v=4s3c1KObSaI",
        "insert_source": "https://www.youtube.com/watch?v=wiiFgsDJ8xk",
        "timeline": [
            {"type": "base", "output_start": 0, "output_end": 7.5, "source_start": 0, "source_end": 7.5},
            {"type": "insert", "output_start": 7.5, "output_end": 7.5 + duration,
             "source_start": start, "source_end": end},
            {"type": "base", "output_start": 7.5 + duration, "output_end": 15 + duration,
             "source_start": 7.5, "source_end": 15},
        ],
        "probe": metadata,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", type=Path, required=True)
    parser.add_argument("--audio", type=Path, required=True,
                        help="Audio trimmed from source 53s through 102s")
    parser.add_argument("--output", type=Path, default=ROOT / "artifacts/demo-videos")
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    results = []
    for start, end in [(53, 72), (76, 102)]:
        insert = ROOT / f"artifacts/wiiFgsDJ8xk-{start}-{end}/download/clip.mp4"
        target = args.output / f"demo-insert-{start}-{end}.mp4"
        results.append(build(args.base, insert, args.audio, start, end, target))
        print(f"Created {target} ({results[-1]['duration_seconds']} seconds)", flush=True)
    (args.output / "timeline.json").write_text(json.dumps(results, indent=2) + "\n")


if __name__ == "__main__":
    main()
