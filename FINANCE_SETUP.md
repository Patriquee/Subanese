# Finance and inventory records

Restart `node server.cjs` and open Admin > Finance. Schema additions preserve existing orders and products. The existing currency setting applies; finance amounts use integer minor units (100 = one KES). Forms accept up to two decimal places.

## Automatic collection

- Each new checkout saves its order totals, customer account ID, and item quantities and prices inside the order transaction.
- Older orders receive an initial snapshot labelled `legacy-derived`. Delivery and discounts are inferred from stored totals; absent historical detail cannot be reconstructed. Missing sizes stay blank; unspecified customization charges stay zero.
- Every subsequent product stock change is logged, including sales, cancellation restocks, administrator adjustments, production, and waste. Opening stock is a starting balance, not reconstructed historical activity.

## Administrator records

- Payments: record an order, amount, method, reference, date and pending/received/failed status. A pending payment can later be confirmed through an appended payment event.
- Refunds: link to a received payment; cumulative refunds cannot exceed the payment. Recording a refund does not send money.
- Expenses/purchases: choose a category, supplier, amount and receipt reference. Reverse an incorrect expense through a new reversal, then enter its replacement.
- Production batches: capture output and total ingredient/packaging costs; output increases product stock.
- Product waste: capture quantity, reason and total cost, optionally linked to a batch; waste decreases product stock. Raw ingredient inventory is not modelled yet.

Duplicate references are rejected; financial records cannot be edited or deleted. Payment failures should be recorded separately from new payment attempts with new references.

## Analysis and exports

All-time summaries distinguish order value from received funds, refunds and outstanding orders. Cash surplus is collections minus refunds and recorded expenses; it is not accounting profit. Production and waste costs are reported separately to avoid deducting ingredient purchases twice. Accurate accounting profit needs matched cost-of-goods-sold and complete operating expenses.

Daily sales use Nairobi dates. Product analysis uses historical line prices and quantities, and repeat-customer analysis uses account IDs. No national ID data is exported in finance records. CSV datasets include integer minor units. Potential spreadsheet formulas are neutralized in exported text cells.

## Integration limit

No payment gateway or supplier system has been connected. All payment confirmations are labelled `manual`. Reconcile entries with cash counts, bank statements or payment-provider statements. Do not treat order completion or a customer-supplied payment reference as verified payment. Automated M-Pesa/card confirmations require the provider's credentials, authenticated callbacks, idempotent event handling and reconciliation, which are not part of this implementation.
