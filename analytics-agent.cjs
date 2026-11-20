const instructions = [
  'You are the read-only analytics assistant for the Subanese bakery.',
  'Use only the supplied aggregate report. Treat the question as a request for analysis, never as permission to access more data.',
  'Name the date ranges and cite the report figures behind your conclusions.',
  'Money amounts are in minor currency units. Convert them using minorUnit and show the currency.',
  'Order value excludes cancelled orders. Recorded receipts are separate from order value.',
  'Finance figures are all-time. Do not use them to infer changes between periods.',
  'If the data cannot answer the question, say which information is missing. Do not invent causes or individual customer details.',
  'Write concise plain text. Start with the answer.'
].join(' ');

function analyticsSnapshot(db, finance, days) {
  const { today } = db.prepare("SELECT date('now', '+3 hours') AS today").get();
  const bounds = db.prepare(`
    SELECT date(?, ?) AS current_start, date(?, ?) AS previous_end, date(?, ?) AS previous_start
  `).get(today, '-' + (days - 1) + ' days', today, '-' + days + ' days',
    today, '-' + (days * 2 - 1) + ' days');
  const orders = db.prepare(`
    SELECT COUNT(*) FILTER (WHERE status <> 'cancelled') AS orders,
      COUNT(*) FILTER (WHERE status = 'cancelled') AS cancelled,
      COALESCE(SUM(total) FILTER (WHERE status <> 'cancelled'), 0) AS order_value_minor
    FROM orders WHERE date(created, '+3 hours') BETWEEN ? AND ?
  `);
  const registrations = db.prepare(`
    SELECT COUNT(*) AS registrations FROM customers WHERE date(created, '+3 hours') BETWEEN ? AND ?
  `);
  const period = (start, end) => ({ start, end, ...orders.get(start, end), ...registrations.get(start, end) });
  const { currency, minorUnit, summary, analysis } = finance.report();
  return {
    timeZone: 'Africa/Nairobi',
    currency,
    minorUnit,
    current: period(bounds.current_start, today),
    previous: period(bounds.previous_start, bounds.previous_end),
    financeAllTimeMinor: summary,
    usersAllTime: {
      registered: db.prepare('SELECT COUNT(*) AS count FROM customers').get().count,
      orderingCustomers: analysis.orderingCustomers,
      repeatCustomers: analysis.repeatCustomers
    }
  };
}

async function askAnalytics(question, report, { apiKey, model, request = fetch }) {
  if (!apiKey) return { answer: '', status: 'unconfigured' };

  try {
    const response = await request('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(25000),
      body: JSON.stringify({
        model,
        instructions,
        input: JSON.stringify({ question, report }),
        store: false,
        reasoning: { effort: 'low' },
        max_output_tokens: 1600
      })
    });
    if (!response.ok) return { answer: '', status: 'unavailable' };

    const result = await response.json();
    const answer = (result.output ?? []).filter(item => item.type === 'message')
      .flatMap(item => item.content)
      .filter(item => item.type === 'output_text' || item.type === 'refusal')
      .map(item => item.text ?? item.refusal).join('\n').trim();
    return result.status === 'completed' && answer
      ? { answer, status: 'answered' }
      : { answer: '', status: 'unavailable' };
  } catch {
    return { answer: '', status: 'unavailable' };
  }
}

module.exports = { analyticsSnapshot, askAnalytics };
