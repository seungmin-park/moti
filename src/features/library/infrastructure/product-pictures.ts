import type { SupabaseClient } from "@supabase/supabase-js";
import type { PictureStore } from "../../metadata/application/picture-copy";

export const PICTURE_BUCKET = "product-pictures";

// The owner's token writes here; the bucket's policies admit only a running job's reserved name, once.
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
