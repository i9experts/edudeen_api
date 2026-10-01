/**
 * READ-ONLY exposure report for the Cash-on-Delivery ledger bug.
 *
 * Bug (fixed in the "COD commission debit" hotfix): when a COD order collected by the
 * SELLER'S courier was marked paid, FinanceService.recordSale credited the seller
 * sale-minus-commission — money the platform never received. This lists every such
 * credit and the payouts the affected stores have taken since, so you can size the loss.
 *
 * Run it yourself against a production READ REPLICA / secondary if you have one:
 *
 *   mongosh "<your production connection string>" --quiet --file scripts/cod-exposure-report.mongosh.js
 *   # optional: only look at orders paid on/after a date
 *   mongosh "<uri>" --quiet --eval 'var SINCE="2025-01-01"' --file scripts/cod-exposure-report.mongosh.js
 *   # optional: also print one row per affected order
 *   mongosh "<uri>" --quiet --eval 'var DETAIL=true' --file scripts/cod-exposure-report.mongosh.js
 *
 * It only calls find()/aggregate()/countDocuments() — it never writes. (Nothing in this file
 * references insert/update/delete/drop; read it before running.) Collection names are
 * Mongoose's defaults: orders, transactions, payouts, sellerbalances.
 *
 * What counts as "affected": an order with paymentType 'cash_on_delivery' and isPaid = true,
 * one sub-order (sellerOrder) per store whose fulfillmentMode is not 'platform' (the field
 * is absent on every pre-hotfix order, i.e. seller-fulfilled), that has a ledger entry of
 * type 'sale' for that (order, store). Note the ledger is per sub-order, so a multi-store
 * COD order produces one row per store.
 *
 * Reading the numbers (all per store + currency, in the store's settlement currency):
 *   creditedNet        sum of net seller credits (sale - commission) booked for these COD sales
 *   creditedGross      sum of the sale amounts themselves (the cash the seller collected)
 *   clearedNet         the part of creditedNet already moved pending -> available (withdrawable)
 *   payoutsSince       payouts (processing + completed) created on/after the store's first affected credit
 *   estPaidOut         min(creditedNet, payoutsSince): conservative estimate of platform cash that
 *                      already left for these sales (payouts are fungible, so this is an upper
 *                      bound on actual loss and assumes the payouts were funded by these credits)
 *   stillOnLedger      creditedNet - estPaidOut: credit not yet withdrawn; recoverable by a
 *                      corrective ledger debit instead of a cash clawback
 *   balance*           the store's current pending/available balance
 * The correct treatment of each affected sale is a COMMISSION DEBIT (creditedGross - creditedNet
 * is the commission the platform was owed), so the true amount owed back by the seller is
 * creditedNet, not just the commission.
 */
var SINCE_DATE = (typeof SINCE !== 'undefined' && SINCE) ? new Date(SINCE) : null;
var SHOW_DETAIL = (typeof DETAIL !== 'undefined' && DETAIL === true);

var orderMatch = { paymentType: 'cash_on_delivery', isPaid: true, isDelete: { $ne: true } };
if (SINCE_DATE) orderMatch.paidAt = { $gte: SINCE_DATE };

var rows = db.getCollection('orders').aggregate([
  { $match: orderMatch },
  { $unwind: '$sellerOrders' },
  { $match: { 'sellerOrders.fulfillmentMode': { $ne: 'platform' } } },
  { $addFields: { orderIdStr: { $toString: '$_id' } } },
  { $lookup: {
      from: 'transactions',
      let: { o: '$orderIdStr', s: '$sellerOrders.storeId' },
      pipeline: [
        { $match: { $expr: { $and: [
          { $eq: ['$referenceId', '$$o'] },
          { $eq: ['$storeId', '$$s'] },
          { $eq: ['$referenceType', 'order'] },
          { $eq: ['$type', 'sale'] },
        ] } } },
        { $project: { _id: 1, amount: 1, currency: 1, status: 1, createdAt: 1, 'metadata.netAmount': 1, 'metadata.platformFee': 1 } },
      ],
      as: 'credit',
  } },
  { $match: { 'credit.0': { $exists: true } } },
  { $project: {
      _id: 0,
      orderId: '$orderIdStr',
      orderNumber: 1,
      paidAt: 1,
      buyerId: '$userId',
      storeId: '$sellerOrders.storeId',
      sellerId: '$sellerOrders.sellerId',
      currency: { $arrayElemAt: ['$credit.currency', 0] },
      gross: { $arrayElemAt: ['$credit.amount', 0] },
      net: { $arrayElemAt: ['$credit.metadata.netAmount', 0] },
      creditStatus: { $arrayElemAt: ['$credit.status', 0] },
      creditedAt: { $arrayElemAt: ['$credit.createdAt', 0] },
  } },
  { $sort: { creditedAt: 1 } },
]).toArray();

print('== COD orders marked paid (seller-fulfilled) that received a seller sale credit: ' + rows.length + ' sub-order(s)' + (SINCE_DATE ? ' since ' + SINCE : ''));

if (SHOW_DETAIL) { rows.forEach(function (r) { printjson(r); }); }

// ---- per store + currency roll-up
var byKey = {};
rows.forEach(function (r) {
  var k = r.storeId + '|' + r.currency;
  var a = byKey[k] || (byKey[k] = { storeId: r.storeId, sellerId: r.sellerId, currency: r.currency, orders: 0, creditedGross: 0, creditedNet: 0, clearedNet: 0, firstCreditAt: r.creditedAt });
  a.orders += 1;
  a.creditedGross += r.gross || 0;
  a.creditedNet += r.net || 0;
  if (r.creditStatus === 'completed') a.clearedNet += r.net || 0;
  if (r.creditedAt < a.firstCreditAt) a.firstCreditAt = r.creditedAt;
});

function r2(n) { return Math.round(n * 100) / 100; }

var report = Object.keys(byKey).map(function (k) {
  var a = byKey[k];
  var paid = db.getCollection('payouts').aggregate([
    { $match: { storeId: a.storeId, currency: a.currency, status: { $in: ['processing', 'completed'] }, createdAt: { $gte: a.firstCreditAt } } },
    { $group: { _id: null, total: { $sum: '$amount' }, n: { $sum: 1 } } },
  ]).toArray()[0] || { total: 0, n: 0 };
  var bal = db.getCollection('sellerbalances').findOne({ storeId: a.storeId, currency: a.currency }) || {};
  var estPaidOut = Math.min(a.creditedNet, paid.total);
  return {
    storeId: a.storeId,
    currency: a.currency,
    affectedSubOrders: a.orders,
    firstCreditAt: a.firstCreditAt,
    creditedGross: r2(a.creditedGross),
    creditedNet: r2(a.creditedNet),
    clearedNet: r2(a.clearedNet),
    payoutsSinceCount: paid.n,
    payoutsSince: r2(paid.total),
    estPaidOut: r2(estPaidOut),
    stillOnLedger: r2(a.creditedNet - estPaidOut),
    balanceAvailable: bal.availableBalance !== undefined ? r2(bal.availableBalance) : null,
    balancePending: bal.pendingBalance !== undefined ? r2(bal.pendingBalance) : null,
  };
}).sort(function (x, y) { return y.estPaidOut - x.estPaidOut; });

print('\n== Per store (worst first)');
report.forEach(function (r) { printjson(r); });

var totals = {};
report.forEach(function (r) {
  var t = totals[r.currency] || (totals[r.currency] = { stores: 0, creditedNet: 0, estPaidOut: 0, stillOnLedger: 0 });
  t.stores += 1; t.creditedNet += r.creditedNet; t.estPaidOut += r.estPaidOut; t.stillOnLedger += r.stillOnLedger;
});
print('\n== Totals by currency');
Object.keys(totals).forEach(function (c) {
  var t = totals[c];
  printjson({ currency: c, stores: t.stores, creditedNet: r2(t.creditedNet), estPaidOut: r2(t.estPaidOut), stillOnLedger: r2(t.stillOnLedger) });
});
