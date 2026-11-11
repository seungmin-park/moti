import { Bookmark, Check, Folder, Link2 } from "lucide-react";
import type { CollectionResponse, ProductResponse } from "../presentation/library-dto";
import { toProductCardView } from "./product-view";

export function LibraryProductCard({
  product,
  collections,
  onOpen,
}: {
  product: ProductResponse;
  collections: CollectionResponse[];
  onOpen: () => void;
}) {
  const view = toProductCardView(product, collections);
  return (
    <article className="product-card">
      <button className="product-open" aria-label={`${view.title}, ${view.shop} 상세 보기`} onClick={onOpen}>
        <div className="product-picture">
          <div className="picture-placeholder">
            <Link2 size={32} aria-hidden="true" />
            <span>링크를 담아두었어요</span>
          </div>
          {(view.status || view.purchased) && (
            <div className="picture-status-list">
              {view.purchased && (
                <span className="picture-status">
                  <Check size={13} aria-hidden="true" /> 구매완료
                </span>
              )}
              {view.status && (
                <span className={`picture-status ${product.metadata.phase === "failed" ? "failed" : ""}`}>{view.status}</span>
              )}
            </div>
          )}
        </div>
        <div className="product-copy">
          <span className="shop-name">{view.shop}</span>
          <h2>{view.title}</h2>
          <p className="product-option">{view.option}</p>
          <p className="product-price">
            <span className="price-value">{view.price.value}</span>
            {view.price.checked && <span className="price-label">{view.price.checked}</span>}
          </p>
          <span className="product-collection">
            {view.collection.filed ? <Folder size={13} aria-hidden="true" /> : <Bookmark size={13} aria-hidden="true" />}
            <span>{view.collection.text}</span>
          </span>
        </div>
      </button>
    </article>
  );
}
