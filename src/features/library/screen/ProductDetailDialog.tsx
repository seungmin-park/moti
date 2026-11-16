"use client";

import { useEffect, useId, useRef, type KeyboardEvent } from "react";
import { ArrowUpRight, Check, CheckCheck, CircleAlert, Clock, Info, LoaderCircle, Plus, RotateCcw, Trash2 } from "lucide-react";
import { Dialog } from "../../wishlist/Dialog";
import { EARLIEST_PURCHASE_DATE, seoulToday } from "../../wishlist/product-fields";
import type { CollectionResponse, ProductResponse } from "../presentation/library-dto";
import { FieldError, fieldProps } from "./AddLinkDialog";
import type { FieldName } from "./library-api";
import { ProductPicture } from "./ProductPicture";
import { toProductDetailView } from "./product-view";
import { collectionFieldKey } from "./collection-field-keys";
import {
  detailForms,
  type DetailDraft,
  type DetailField,
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

// 삭제 asks inside the dialog first. Escape or 취소 closes only the question, and the focus goes back to 삭제.
function DeleteProduct({ id, confirming, deleting, blocked, error, send, productId }: {
  id: string;
  confirming: boolean;
  deleting: boolean;
  blocked: boolean;
  error: FormError | null;
  send: (event: ScreenEvent) => void;
  productId: string;
}) {
  const opener = useRef<HTMLButtonElement>(null);
  const asked = useRef(false);
  useEffect(() => {
    if (confirming) {
      asked.current = true;
      return;
    }
    if (asked.current) opener.current?.focus();
    asked.current = false;
  }, [confirming]);
  const cancelOnEscape = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || deleting) return;
    event.preventDefault();
    send({ type: "detail.deleteCancel" });
  };
  const messageId = `${id}-delete-message`;
  return (
    <div className="delete-product">
      {confirming ? (
        <div className="share-confirm delete-confirm" role="group" aria-labelledby={messageId} onKeyDown={cancelOnEscape}>
          <p id={messageId}>이 상품을 삭제할까요? 메모, 컬렉션 소속과 구매 기록도 함께 지워지고 되돌릴 수 없어요.</p>
          <div className="share-key-actions">
            <button className="button secondary" type="button" autoFocus disabled={deleting} onClick={() => send({ type: "detail.deleteCancel" })}>
              취소
            </button>
            <button className="button primary" type="button" disabled={blocked} onClick={() => send({ type: "product.delete", productId })}>
              {deleting ? "삭제하는 중…" : "삭제하기"}
            </button>
          </div>
        </div>
      ) : (
        <button ref={opener} className="text-button delete-button" type="button" disabled={blocked} onClick={() => send({ type: "detail.deleteAsk" })}>
          <Trash2 size={15} aria-hidden="true" />
          삭제
        </button>
      )}
      <FieldError id={`${id}-delete-form-error`} error={error} field={null} />
    </div>
  );
}

// The collection checkboxes and, under them, "새 컬렉션": a name field that creates the collection and checks it in the
// draft. Enter or 만들기 creates, Escape or 취소 closes only the field. The focus then goes to the new checkbox, or back
// to "새 컬렉션", unless the owner has since moved into another field of the dialog. A refused name takes the focus
// back to the field. While the collection is being made the checkboxes wait with the rest of the dialog.
function CollectionOptions({ id, collections, checkedIds, field, error, saving, blocked, send }: {
  id: string;
  collections: CollectionResponse[];
  checkedIds: string[];
  field: { name: string; creating: boolean } | null;
  error: FormError | null;
  saving: boolean;
  blocked: boolean;
  send: (event: ScreenEvent) => void;
}) {
  const root = useRef<HTMLFieldSetElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  // Set when the owner asks to create, so only that answer's error moves the focus.
  const asked = useRef(false);
  // The collections shown when the field opened, so a closed field can tell which checkbox it made.
  const known = useRef<Set<string> | null>(null);
  const open = field !== null;
  useEffect(() => {
    if (open) {
      known.current ??= new Set(collections.map((collection) => collection.id));
      return;
    }
    const before = known.current;
    known.current = null;
    if (!before) return;
    const active = document.activeElement;
    const typing = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement;
    if (typing && !root.current?.contains(active)) return;
    const made = collections.find((collection) => !before.has(collection.id) && checkedIds.includes(collection.id));
    const target = made ? root.current?.querySelector<HTMLInputElement>(`input[data-collection-id="${made.id}"]`) : opener.current;
    target?.focus();
  }, [open, collections, checkedIds]);
  // A rejected name or a failed request: 만들기 may have turned disabled under the pointer, so the focus returns to the
  // name to fix it.
  const creating = field?.creating === true;
  const refused = error !== null;
  useEffect(() => {
    if (!open) asked.current = false;
    if (!asked.current || creating || !refused) return;
    asked.current = false;
    nameInput.current?.focus();
  }, [open, creating, refused, error]);
  const errorId = `${id}-collection-create-error`;
  const canCreate = !creating && !blocked;
  const create = () => {
    asked.current = true;
    send({ type: "detail.collectionCreate" });
  };
  const keys = (event: KeyboardEvent<HTMLInputElement>) => {
    const action = collectionFieldKey(event.nativeEvent, canCreate);
    if (action === null) return;
    // Enter would submit the details form and Escape would close the dialog: both stay with the field.
    event.preventDefault();
    if (action === "create") create();
    else if (action === "cancel") send({ type: "detail.collectionCancel" });
  };
  return (
    <fieldset ref={root} className="collection-options" disabled={saving}>
      <legend>컬렉션</legend>
      {collections.length === 0 && <p className="field-help">아직 만든 컬렉션이 없어요.</p>}
      {collections.map((collection) => (
        <label key={collection.id}>
          <input
            type="checkbox"
            data-collection-id={collection.id}
            disabled={creating}
            checked={checkedIds.includes(collection.id)}
            onChange={() => send({ type: "detail.toggle", collectionId: collection.id })}
          />
          <span>{collection.name}</span>
        </label>
      ))}
      {field ? (
        <div className="collection-create" aria-busy={field.creating}>
          <label className="field">
            <span>새 컬렉션 이름</span>
            <input
              ref={nameInput}
              autoFocus
              autoComplete="off"
              enterKeyHint="done"
              placeholder="예: 오래 머물고 싶은 방"
              value={field.name}
              readOnly={field.creating}
              onChange={(event) => send({ type: "detail.collectionEdit", name: event.target.value })}
              onKeyDown={keys}
              {...fieldProps(error, "collection", errorId)}
            />
          </label>
          <FieldError id={errorId} error={error} field="collection" />
          <FieldError id={`${id}-collection-create-form-error`} error={error} field={null} />
          <div className="collection-create-actions">
            <button className="button secondary" type="button" disabled={!canCreate} onClick={create}>
              {field.creating ? "만드는 중…" : "만들기"}
            </button>
            <button className="text-button" type="button" disabled={field.creating} onClick={() => send({ type: "detail.collectionCancel" })}>
              취소
            </button>
          </div>
        </div>
      ) : (
        <button ref={opener} className="text-button collection-add" type="button" onClick={() => send({ type: "detail.collectionOpen" })}>
          <Plus size={15} aria-hidden="true" />
          새 컬렉션
        </button>
      )}
    </fieldset>
  );
}

export function ProductDetailDialog({
  product,
  collections,
  arrival,
  draft,
  notice,
  confirming,
  newCollection,
  writing,
  blocked,
  send,
}: {
  product: ProductResponse;
  collections: CollectionResponse[];
  arrival: "added" | "duplicate" | null;
  draft: DetailDraft;
  notice: DetailNotice | null;
  // The owner pressed 삭제 and the dialog is asking before it sends anything.
  confirming: boolean;
  // The open "새 컬렉션" field, if any.
  newCollection: { name: string; creating: boolean } | null;
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
  // A collection being made from this dialog: every field waits, so nothing typed meanwhile is dropped.
  const frozen = saving || newCollection?.creating === true;
  const errorOf = (form: DetailForm): FormError | null =>
    notice?.kind === "error" && notice.form === form ? { field: notice.field, message: notice.message } : null;
  const errorId = (form: DetailForm, field: FieldName | null) => `${id}-${form}-${field ?? "form"}-error`;
  const detailsError = errorOf("details");
  const recordError = errorOf("record");
  const statusError = errorOf("status");
  const retryError = errorOf("retry");
  const deleteError = errorOf("delete");
  const wishPriceError = errorOf("wishPrice");
  const wishPriceHelp = `${id}-wish-price-help`;
  const edit = (field: DetailField, value: string) => send({ type: "detail.edit", field, value });
  const save = (form: "details" | "record" | "wishPrice") => send({ type: "detail.save", form, today: seoulToday(new Date()) });
  const wishPriceForm = useRef<HTMLFormElement>(null);
  const wishPriceInput = useRef<HTMLInputElement>(null);
  // Set when the owner saves or clears from this form, so only that answer moves the focus.
  const wishPriceAsked = useRef(false);
  const wishPriceNotice = notice?.form === "wishPrice" ? notice : null;
  // After a save or a clear the pressed button turns disabled or disappears, so the focus would fall to the page
  // (WebKit does not focus a clicked button at all). Move it to the price field, unless the owner has since moved
  // into another field of the dialog.
  useEffect(() => {
    if (!wishPriceNotice || !wishPriceAsked.current) return;
    wishPriceAsked.current = false;
    const input = wishPriceInput.current;
    if (wishPriceNotice.kind !== "saved" || !input) return;
    const active = document.activeElement;
    const typing = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement || active instanceof HTMLSelectElement;
    if (active !== input && !(typing && !wishPriceForm.current?.contains(active))) input.focus();
  }, [wishPriceNotice]);
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
            {view.price.marker && <span className="price-marker">{view.price.marker}</span>}
            {view.price.checked && <p>{view.price.checked}</p>}
            {view.priceKept && (
              <p className="price-kept">
                <Info size={14} aria-hidden="true" />
                {view.priceKept}
              </p>
            )}
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
          {!purchased && (
            <form
              ref={wishPriceForm}
              className="wish-price-form"
              noValidate
              aria-busy={writing === "wish.price"}
              onSubmit={(event) => {
                event.preventDefault();
                wishPriceAsked.current = true;
                save("wishPrice");
              }}
            >
              <label className="field">
                <span>
                  내가 살 가격 <small>원</small>
                </span>
                <input
                  ref={wishPriceInput}
                  inputMode="numeric"
                  autoComplete="off"
                  placeholder="미입력"
                  value={forms.wishPrice}
                  readOnly={frozen}
                  onChange={(event) => edit("wishPrice", event.target.value)}
                  {...fieldProps(wishPriceError, "wishPrice", errorId("wishPrice", "wishPrice"))}
                  aria-describedby={
                    wishPriceError?.field === "wishPrice" ? `${wishPriceHelp} ${errorId("wishPrice", "wishPrice")}` : wishPriceHelp
                  }
                />
              </label>
              <p className="field-help" id={wishPriceHelp}>
                옵션·묶음·쿠폰으로 실제 낼 가격이 다르면 적어 주세요. 자동 확인 가격은 따로 남아요.
              </p>
              <FieldError id={errorId("wishPrice", "wishPrice")} error={wishPriceError} field="wishPrice" />
              <FieldError id={errorId("wishPrice", null)} error={wishPriceError} field={null} />
              <Saved notice={notice} form="wishPrice" />
              <div className="wish-price-actions">
                <button className="button secondary" type="submit" disabled={!forms.wishPriceChanged || saving || blocked}>
                  {writing === "wish.price" ? "저장하는 중…" : "가격 저장"}
                </button>
                {product.wishPrice && (
                  <button
                    className="text-button"
                    type="button"
                    disabled={saving || blocked}
                    onClick={() => {
                      wishPriceAsked.current = true;
                      send({ type: "detail.clearWishPrice" });
                    }}
                  >
                    직접 입력 지우기
                  </button>
                )}
              </div>
            </form>
          )}
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
                readOnly={frozen}
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
                readOnly={frozen}
                onChange={(event) => edit("note", event.target.value)}
                {...fieldProps(detailsError, "note", errorId("details", "note"))}
              />
            </label>
            <FieldError id={errorId("details", "note")} error={detailsError} field="note" />
            <CollectionOptions
              id={id}
              collections={collections}
              checkedIds={forms.collectionIds}
              field={newCollection}
              error={errorOf("collection")}
              saving={saving}
              blocked={blocked}
              send={send}
            />
            <FieldError id={errorId("details", "collection")} error={detailsError} field="collection" />
            <FieldError id={errorId("details", null)} error={detailsError} field={null} />
            <Saved notice={notice} form="details" />
            <button
              className="button secondary full"
              type="submit"
              disabled={!forms.detailsChanged || saving || blocked}
            >
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
                    readOnly={frozen}
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
                    readOnly={frozen}
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
          <DeleteProduct
            id={id}
            confirming={confirming}
            deleting={writing === "delete"}
            blocked={blocked}
            error={deleteError}
            send={send}
            productId={product.id}
          />
        </div>
      </div>
    </Dialog>
  );
}
