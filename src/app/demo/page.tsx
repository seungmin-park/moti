import type { Metadata } from "next";
import Mockup from "@/features/wishlist/Mockup";

export const metadata: Metadata = {
  title: "moti · 목업 둘러보기",
  description: "예시 데이터로 체험하는 moti 목업.",
};

export default function DemoPage() {
  return <Mockup />;
}
