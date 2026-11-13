import { Bookmark, Check, Folder } from "lucide-react";
import type { CollectionResponse, ProductResponse } from "../presentation/library-dto";
import { ProductPicture } from "./ProductPicture";
import { toProductCardView } from "./product-view";

export function LibraryProductCard({
  product,
  collections,
  purchasing,
  onOpen,
  onPurchase,
}: {
  product: ProductResponse;
  collections: CollectionResponse[];
  purchasing: boolean;
  onOpen: () => void;
  onPurchase: () => void;
}) {
  const view = toProductCardView(product, collections);
  return (
    <article className="product-card">
      <button className="product-open" aria-label={`${view.title}, ${view.shop} 상세 보기`} onClick={onOpen}>
        <div className="product-picture">
          <ProductPicture view={view.picture} sizes="(max-width: 640px) 50vw, (max-width: 1100px) 33vw, 350px" iconSize={32} />
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
      {!view.purchased && (
        <button
          className="quick-purchase"
          aria-label={`${view.title} 구매완료로 이동`}
          title="구매완료로 이동"
          disabled={purchasing}
          onClick={onPurchase}
        >
          <Check size={17} aria-hidden="true" />
        </button>
      )}
    </article>
  );
}
