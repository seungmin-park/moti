export type PriceCandidate = { amount: string; currency: string | null };

// What a product page states about itself, before any decision about what to keep.
export type PageFacts = {
  title: string | null;
  prices: PriceCandidate[];
  imageUrl: string | null;
};
