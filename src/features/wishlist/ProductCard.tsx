import Image from "next/image";
import { Bookmark, Check, Folder, Link2 } from "lucide-react";
import {
  formatPrice,
  productPrice,
  type Collection,
  type Product,
} from "./model";

type Props = {
  product: Product;
  collections: Collection[];
  onOpen: () => void;
  onPurchase: () => void;
};

export function ProductCard({
  product,
  collections,
  onOpen,
  onPurchase,
}: Props) {
  const collection = collections.find((c) =>
    product.collectionIds.includes(c.id),
  );
  const purchased = product.purchase.status === "purchased";
  const price = productPrice(product);
  return (
    <article className="product-card">
      <button
        className="product-open"
        aria-label={`${product.title} 상세 보기`}
        onClick={onOpen}
      >
        <div className="product-picture">
          {product.image ? (
            <Image
              src={product.image}
              alt=""
              width={800}
              height={800}
              sizes="(max-width: 640px) 50vw, (max-width: 1100px) 33vw, 350px"
            />
          ) : (
            <div className="picture-placeholder">
              <Link2 size={32} />
              <span>링크를 담아두었어요</span>
            </div>
          )}
          {purchased && (
            <span className="picture-status">
              <Check size={13} /> 구매완료
            </span>
          )}
          {product.metadata.phase === "collecting" && (
            <span className="picture-status collecting">
              정보 수집 중 · 예시
            </span>
          )}
          {product.metadata.phase === "failed" && (
            <span className="picture-status failed">링크 보관됨</span>
          )}
        </div>
        <div className="product-copy">
          <span className="shop-name">{product.shop}</span>
          <h2>{product.title}</h2>
          <p className="product-option">{product.option || "옵션 미입력"}</p>
          <p className="product-price">
            <span className="price-value">
              {purchased && price === null
                ? "실구매가 미입력"
                : formatPrice(price)}
            </span>
            {(!purchased || price !== null) && (
              <span className="price-label">
                {purchased ? "실구매가" : "예시 가격"}
              </span>
            )}
          </p>
          <span className="product-collection">
            {collection ? (
              <>
                <Folder size={13} />
                <span>
                  {collection.name}
                  {product.collectionIds.length > 1
                    ? ` +${product.collectionIds.length - 1}`
                    : ""}
                </span>
              </>
            ) : (
              <>
                <Bookmark size={13} />
                아직 분류하지 않았어요
              </>
            )}
          </span>
        </div>
      </button>
      {!purchased && (
        <button
          className="quick-purchase"
          aria-label={`${product.title} 구매완료로 이동`}
          title="구매완료로 이동"
          onClick={onPurchase}
        >
          <Check size={17} />
        </button>
      )}
    </article>
  );
}
