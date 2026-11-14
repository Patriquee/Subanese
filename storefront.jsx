import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';

export function ProductCard({ product, image, price, onDetails, onAdd }) {
  const available = product.stock > 0;
  return <>
    <button type="button" className="minimal-product-link tw:w-full"
      data-product={product.id} aria-haspopup="dialog" aria-controls="cake-details"
      aria-label={`View details for ${product.name}${available ? '' : ' (sold out)'}`}
      onClick={() => onDetails(product.id)}>
      <span className="minimal-product-name">{product.name}</span>
      {/* The existing photo helper supplies trusted image markup, including responsive sources. */}
      <span className="minimal-product-image tw:block tw:overflow-hidden" dangerouslySetInnerHTML={{ __html: image }} />
      <span className="minimal-product-price">{price}{product.category === 'Cakes' && <> <small>/ 1 kg cake</small></>}</span>
    </button>
    <button type="button" className="btn minimal-add tw:transition-opacity tw:motion-reduce:transition-none tw:disabled:cursor-not-allowed tw:disabled:opacity-50"
      data-add={product.id} aria-label={`Add ${product.name} to bag`} disabled={!available}
      onClick={() => onAdd(product.id)}>{available ? 'Add to bag +' : 'Sold out'}</button>
  </>;
}

const roots = new Map();
function removeDetachedRoots() {
  for (const [element, root] of roots) {
    if (!element.isConnected) {
      root.unmount();
      roots.delete(element);
    }
  }
}

window.SubaneseUI = {
  mountProductCards({ products, photo, money, onDetails, onAdd }) {
    removeDetachedRoots();
    const byId = new Map(products.map(product => [product.id, product]));
    document.querySelectorAll('article.minimal-product').forEach(element => {
      if (roots.has(element)) return;
      const product = byId.get(Number(element.querySelector('[data-product]')?.dataset.product));
      if (!product) return;
      const root = createRoot(element);
      roots.set(element, root);
      element.dataset.reactProduct = String(product.id);
      flushSync(() => root.render(<ProductCard product={product} image={photo(product)} price={money(product.price)} onDetails={onDetails} onAdd={onAdd} />));
    });
  },
};

// Hash routes and filters replace legacy containers; release their React roots.
new MutationObserver(removeDetachedRoots).observe(document.body, { childList: true, subtree: true });
