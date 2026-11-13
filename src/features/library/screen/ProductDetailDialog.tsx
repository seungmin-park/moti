"use client";

import { useId } from "react";
import { ArrowUpRight, Check, CheckCheck, CircleAlert, Clock, LoaderCircle, RotateCcw } from "lucide-react";
import { Dialog } from "../../wishlist/Dialog";
import { EARLIEST_PURCHASE_DATE, seoulToday } from "../../wishlist/product-fields";
import type { CollectionResponse, ProductResponse } from "../presentation/library-dto";
import { FieldError, fieldProps } from "./AddLinkDialog";
import type { FieldName } from "./library-api";
import { ProductPicture } from "./ProductPicture";
import { toProductDetailView } from "./product-view";
import {
  detailForms,
  type DetailDraft,
  type DetailForm,
  type DetailNotice,
  type FormError,
  type ProductIntent,
  type ScreenEvent,
} from "./screen-state";

function Saved({ notice, form }: { notice: DetailNotice | null; form: DetailForm }) {
  if (notice?.kind !== "saved" || notice.form !== form) return null;
  return (
    <p className="form-success" role="status">
      <Check size={16} aria-hidden="true" />
      {notice.message}
    </p>
  );
}

export function ProductDetailDialog({
  product,
  collections,
  arrival,
  draft,
  notice,
  writing,
  blocked,
  send,
}: {
  product: ProductResponse;
  collections: CollectionResponse[];
  arrival: "added" | "duplicate" | null;
  draft: DetailDraft;
  notice: DetailNotice | null;
  // This product's write in flight, if any.
  writing: ProductIntent | null;
  // Any write or re-read in flight: every button that would write waits.
  blocked: boolean;
  send: (event: ScreenEvent) => void;
}) {
  const id = useId();
  const view = toProductDetailView(product, arrival);
  const forms = detailForms(product, draft);
  const phase = product.metadata.phase;
  const purchased = product.purchase.status === "purchased";
  const saving = writing !== null && writing !== "retry";
  const errorOf = (form: DetailForm): FormError | null =>
    notice?.kind === "error" && notice.form === form ? { field: notice.field, message: notice.message } : null;
  const errorId = (form: DetailForm, field: FieldName | null) => `${id}-${form}-${field ?? "form"}-error`;
  const detailsError = errorOf("details");
  const recordError = errorOf("record");
  const statusError = errorOf("status");
  const retryError = errorOf("retry");
  const edit = (field: "title" | "note" | "date" | "price", value: string) => send({ type: "detail.edit", field, value });
  const save = (form: "details" | "record") => send({ type: "detail.save", form, today: seoulToday(new Date()) });
  return (
    <Dialog title="담아둔 물건" wide onClose={() => send({ type: "dialog.close" })}>
      {view.arrival && (
        <p className="duplicate-notice" role="status">
          <CheckCheck size={18} aria-hidden="true" />
          {view.arrival}
        </p>
      )}
      <div className="detail-body">
        <div className="detail-visual">
          <div className="detail-picture">
            <ProductPicture view={view.picture} sizes="(max-width: 640px) 90vw, 400px" iconSize={40} />
          </div>
          {view.openUrl && (
            <a className="button secondary original-link" href={view.openUrl} target="_blank" rel="noopener noreferrer">
              원본 링크 열기 <ArrowUpRight size={17} aria-hidden="true" />
            </a>
          )}
          <p className="source-url">{view.sourceUrl}</p>
        </div>
        <div className="detail-info">
          <span className="shop-name">{view.shop}</span>
          <h3>{view.title}</h3>
          <p className="detail-option">{view.option}</p>
          <div className="detail-price">
            <strong>{view.price.value}</strong>
            {view.price.checked && <p>{view.price.checked}</p>}
          </div>
          <div className={`metadata-status ${view.canRetry ? "failed" : phase}`}>
            {view.canRetry ? (
              <CircleAlert size={20} aria-hidden="true" />
            ) : phase === "ready" ? (
              <Check size={20} aria-hidden="true" />
            ) : phase === "queued" ? (
              <Clock size={20} aria-hidden="true" />
            ) : (
              <LoaderCircle size={20} aria-hidden="true" />
            )}
            <div>
              <strong>{view.status.title}</strong>
              <p>{view.status.detail}</p>
            </div>
          </div>
          {view.canRetry && (
            <button
              className="text-button retry-button"
              type="button"
              disabled={blocked}
              onClick={() => send({ type: "metadata.retry", productId: product.id })}
            >
              <RotateCcw size={15} aria-hidden="true" />
              {writing === "retry" ? "다시 가져오는 중" : "다시 가져오기"}
            </button>
          )}
          {retryError && (
            <p className="form-error retry-error" role="alert">
              {retryError.message}
            </p>
          )}
          <dl className="detail-facts">
            <div>
              <dt>담은 날</dt>
              <dd>{view.addedOn}</dd>
            </div>
            {view.purchased && (
              <div>
                <dt>상태</dt>
                <dd>구매완료</dd>
              </div>
            )}
          </dl>
          <form
            className="detail-form"
            noValidate
            aria-busy={writing === "details"}
            onSubmit={(event) => {
              event.preventDefault();
              save("details");
            }}
          >
            <label className="field">
              <span>상품 이름</span>
              <input
                value={forms.title}
                readOnly={saving}
                onChange={(event) => edit("title", event.target.value)}
                {...fieldProps(detailsError, "title", errorId("details", "title"))}
              />
            </label>
            <FieldError id={errorId("details", "title")} error={detailsError} field="title" />
            <label className="field">
              <span>메모</span>
              <textarea
                rows={3}
                placeholder="마음에 든 이유, 살 때 확인할 것들…"
                value={forms.note}
                readOnly={saving}
                onChange={(event) => edit("note", event.target.value)}
                {...fieldProps(detailsError, "note", errorId("details", "note"))}
              />
            </label>
            <FieldError id={errorId("details", "note")} error={detailsError} field="note" />
            <fieldset className="collection-options" disabled={saving}>
              <legend>컬렉션</legend>
              {collections.length === 0 && <p className="field-help">아직 만든 컬렉션이 없어요.</p>}
              {collections.map((collection) => (
                <label key={collection.id}>
                  <input
                    type="checkbox"
                    checked={forms.collectionIds.includes(collection.id)}
                    onChange={() => send({ type: "detail.toggle", collectionId: collection.id })}
                  />
                  <span>{collection.name}</span>
                </label>
              ))}
            </fieldset>
            <FieldError id={errorId("details", "collection")} error={detailsError} field="collection" />
            <FieldError id={errorId("details", null)} error={detailsError} field={null} />
            <Saved notice={notice} form="details" />
            <button className="button secondary full" type="submit" disabled={!forms.detailsChanged || saving || blocked}>
              {writing === "details" ? "저장하는 중…" : "변경사항 저장"}
            </button>
          </form>
          {purchased && (
            <form
              className="purchase-form"
              noValidate
              aria-busy={writing === "purchase.record"}
              onSubmit={(event) => {
                event.preventDefault();
                save("record");
              }}
            >
              <div className="section-caption">
                <span>구매 기록</span>
                <small>모두 선택 입력이에요</small>
              </div>
              <div className="purchase-inputs">
                <label className="field">
                  <span>구매일</span>
                  <input
                    type="date"
                    min={EARLIEST_PURCHASE_DATE}
                    max={seoulToday(new Date())}
                    value={forms.date}
                    readOnly={saving}
                    onChange={(event) => edit("date", event.target.value)}
                    {...fieldProps(recordError, "date", errorId("record", "date"))}
                  />
                </label>
                <label className="field">
                  <span>
                    실구매가 <small>원</small>
                  </span>
                  <input
                    inputMode="numeric"
                    placeholder="미입력"
                    value={forms.price}
                    readOnly={saving}
                    onChange={(event) => edit("price", event.target.value)}
                    {...fieldProps(recordError, "price", errorId("record", "price"))}
                  />
                </label>
              </div>
              <FieldError id={errorId("record", "date")} error={recordError} field="date" />
              <FieldError id={errorId("record", "price")} error={recordError} field="price" />
              <FieldError id={errorId("record", null)} error={recordError} field={null} />
              <Saved notice={notice} form="record" />
              <button className="button secondary full" type="submit" disabled={!forms.recordChanged || saving || blocked}>
                {writing === "purchase.record" ? "저장하는 중…" : "구매 정보 저장"}
              </button>
            </form>
          )}
          <button
            className="button primary full purchase-button"
            type="button"
            disabled={saving || blocked}
            onClick={() => send({ type: purchased ? "product.wish" : "product.purchase", productId: product.id })}
          >
            {purchased ? <RotateCcw size={17} aria-hidden="true" /> : <Check size={17} aria-hidden="true" />}
            {purchased ? "위시로 되돌리기" : "구매완료로 이동"}
          </button>
          <FieldError id={errorId("status", null)} error={statusError} field={null} />
        </div>
      </div>
    </Dialog>
  );
}
