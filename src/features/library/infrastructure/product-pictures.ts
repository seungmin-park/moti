import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { PictureObject, PictureStore } from "../../metadata/application/picture-copy";
import type { PictureOrphanStore } from "../application/picture-sweep";

export const PICTURE_BUCKET = "product-pictures";
// A signed link can't be revoked, so it lives one hour; the picture route redirects to a fresh one each time.
export const PICTURE_LINK_SECONDS = 3600;

const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
// `<owner>/<product>/<job>-<attempt>.webp`, as moti.picture_object makes it.
export const pictureObjectSchema = z.string().regex(new RegExp(`^${uuid}/${uuid}/${uuid}-[1-3]\\.webp$`))
  .transform((name) => name as PictureObject);

// The owner's token writes here; the bucket's policies admit only a running job's reserved name, and no overwrite.
export function createPictureStore(client: SupabaseClient): PictureStore {
  const bucket = () => client.storage.from(PICTURE_BUCKET);
  return {
    async put(object, picture) {
      try {
        const { error } = await bucket().upload(object, picture.bytes, { contentType: "image/webp", upsert: false, cacheControl: "3600" });
        return error === null;
      } catch {
        return false;
      }
    },
    async discard(objects) {
      if (objects.length === 0) return;
      await bucket().remove([...objects]).catch(() => undefined);
    },
  };
}

// Names only, never the objects: the server hands them straight to discard under the same owner token.
export function createPictureOrphanStore(client: SupabaseClient): PictureOrphanStore {
  return {
    async find(limit) {
      const { data, error } = await client.rpc("moti_picture_orphans", { p_limit: limit });
      if (error) throw new Error(`moti_picture_orphans ${error.code}`);
      return z.array(pictureObjectSchema).parse(data);
    },
  };
}
