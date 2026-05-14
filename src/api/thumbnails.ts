import { getBearerToken, validateJWT } from "../auth";
import { respondWithJSON } from "./json";
import { getVideo, updateVideo } from "../db/videos";
import type { ApiConfig } from "../config";
import type { BunRequest } from "bun";
import { BadRequestError, NotFoundError, UserForbiddenError } from "./errors";
import path from "path";
import { randomBytes } from "crypto";

type Thumbnail = {
  data: ArrayBuffer;
  mediaType: string;
};

export async function handlerGetThumbnail(cfg: ApiConfig, req: BunRequest) {
  const { videoId } = req.params as { videoId?: string };
  if (!videoId) {
    throw new BadRequestError("Invalid video ID");
  }

  const video = getVideo(cfg.db, videoId);
  if (!video) {
    throw new NotFoundError("Couldn't find video");
  }

  return new Response(video.videoURL, {
    headers: {
      "Content-Type": video.thumbnailURL
        ? "text/plain"
        : "application/octet-stream",
      "Cache-Control": "no-store",
    },
  });
}

export async function handlerUploadThumbnail(cfg: ApiConfig, req: BunRequest) {
  const { videoId } = req.params as { videoId?: string };
  if (!videoId) {
    throw new BadRequestError("Invalid video ID");
  }

  const token = getBearerToken(req.headers);
  const userID = validateJWT(token, cfg.jwtSecret);

  console.log("uploading thumbnail for video", videoId, "by user", userID);

  // TODO: implement the upload here

  const formData = await req.formData();
  const file = formData.get("thumbnail");
  if (!(file instanceof File)) {
    throw new BadRequestError("Thumbnail is missing");
  }

  const MAX_UPLOAD_SIZE = 10 << 20; // 10 MB
  if (file.size > MAX_UPLOAD_SIZE) {
    throw new BadRequestError("Thumbnail is too large");
  }

  const mediaType = file.type;

  if (mediaType !== "image/jpeg" && mediaType !== "image/png")
    throw new BadRequestError("Unsupported media type");

  const data = await file.arrayBuffer();

  const video = getVideo(cfg.db, videoId);

  if (!video) {
    throw new UserForbiddenError(
      " Video doesn't belong to you or doesn't exist",
    );
  }

  const filePath = `${randomBytes(32).toString("base64url")}.${mediaType.split("/")[1]}`;
  const fullPath = path.join(cfg.assetsRoot, filePath);
  await Bun.write(fullPath, file);

  video.thumbnailURL = `http://localhost:${cfg.port}/${fullPath}`;

  updateVideo(cfg.db, video);

  return respondWithJSON(200, video);
}
