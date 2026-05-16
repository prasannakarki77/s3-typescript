import { respondWithJSON } from "./json";

import { type ApiConfig } from "../config";
import type { BunRequest } from "bun";
import { getBearerToken, validateJWT } from "../auth";
import { getVideo, updateVideo } from "../db/videos";
import { BadRequestError, NotFoundError, UserForbiddenError } from "./errors";
import { randomBytes } from "crypto";

const MAX_UPLOAD_SIZE = 1 << 30; // 1 GB

export async function handlerUploadVideo(cfg: ApiConfig, req: BunRequest) {
  const { videoId } = req.params as { videoId?: string };

  if (!videoId) {
    return respondWithJSON(400, { error: "Invalid video ID" });
  }

  const token = getBearerToken(req.headers);
  const userID = validateJWT(token, cfg.jwtSecret);

  const video = getVideo(cfg.db, videoId);
  if (!video) throw new NotFoundError("Couldn't find video");

  if (video.userID !== userID) {
    throw new UserForbiddenError(
      "You don't have permission to upload video for this video ID",
    );
  }
  const formData = await req.formData();
  const file = formData.get("video");
  if (!(file instanceof File))
    throw new BadRequestError("Video file is missing");

  if (file.size > MAX_UPLOAD_SIZE)
    throw new BadRequestError("Video file is too large");

  const videoType = file.type;

  if (videoType !== "video/mp4") {
    throw new BadRequestError("Only MP4 videos are allowed");
  }

  const localFilePath = `./temp/${videoId}.mp4`;

  await Bun.write(localFilePath, file);
  const aspectRatio = await getVideoAspectRatio(localFilePath);

  const fileKey = `${aspectRatio}/${randomBytes(32).toString("hex")}.${videoType.split("/")[1]}`;
  const processedFilePath = await processVideoForFastStart(localFilePath);

  const localFile = Bun.file(processedFilePath);

  const s3File = cfg.s3Client.file(fileKey, {
    bucket: cfg.s3Bucket,
    region: cfg.s3Region,
    type: videoType,
  });

  const buffer = await localFile.arrayBuffer();
  await s3File.write(buffer);

  video.videoURL = `https://${cfg.s3Bucket}.s3.${cfg.s3Region}.amazonaws.com/${fileKey}`;
  updateVideo(cfg.db, video);
  await Bun.file(processedFilePath).delete();
  await Bun.file(localFilePath).delete();

  return respondWithJSON(200, null);
}

export async function getVideoAspectRatio(filePath: string) {
  const proc = Bun.spawn(
    [
      "ffprobe",
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=width,height",
      "-of",
      "json",
      filePath,
    ],
    {
      stderr: "pipe",
      stdout: "pipe",
    },
  );
  const stdoutText = await new Response(proc.stdout).text();
  const stderrText = await new Response(proc.stderr).text();

  if (stderrText) {
    console.error("ffprobe error:", stderrText);
    throw new Error("Failed to get video aspect ratio");
  }

  const ffprobeOutput = JSON.parse(stdoutText);
  const stream = ffprobeOutput.streams[0];
  if (!stream) {
    throw new Error("No video stream found");
  }

  const { width, height } = stream;
  if (!width || !height) {
    throw new Error("Invalid video dimensions");
  }

  return `${Math.floor(width)}:${Math.floor(height)}`;
}

export async function processVideoForFastStart(inputFilePath: string) {
  const outputFilePath = inputFilePath.replace(".mp4", ".processed.mp4");

  const proc = Bun.spawn([
    "ffmpeg",
    "-i",
    inputFilePath,
    "-movflags",
    "faststart",
    "-map_metadata",
    "0",
    "-codec",
    "copy",
    "-f",
    "mp4",
    outputFilePath,
  ]);

  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    throw new Error("ffmpeg processing failed");
  }

  return outputFilePath;
}
