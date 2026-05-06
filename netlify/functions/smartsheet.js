// netlify/functions/smartsheet.js
// Proxy between the browser app and the Smartsheet API.
// The browser sends { action, apiKey, sheetId, ...payload }
// This function forwards to Smartsheet server-side (no CORS issues).

const SS_BASE = 'https://api.smartsheet.com/2.0';

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  // Handle CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  const { action, apiKey, sheetId } = body;

  if (!apiKey || !sheetId) {
    return {
      statusCode: 400, headers,
      body: JSON.stringify({ error: 'Missing apiKey or sheetId in request body' }),
    };
  }

  const ssHeaders = {
    'Authorization': `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };

  // ─── PING / TEST CONNECTION ───────────────────────────────
  if (action === 'ping' || action === 'getColumns') {
    try {
      const res = await fetch(`${SS_BASE}/sheets/${sheetId}?include=columnOnly`, {
        headers: ssHeaders,
      });
      const data = await res.json();

      if (!res.ok) {
        return {
          statusCode: res.status, headers,
          body: JSON.stringify({ ok: false, error: data.message || 'Smartsheet error', hint: data.message }),
        };
      }

      return {
        statusCode: 200, headers,
        body: JSON.stringify({
          ok: true,
          sheetName: data.name,
          columnCount: (data.columns || []).length,
          columns: (data.columns || []).map(c => ({ id: c.id, title: c.title, type: c.type })),
        }),
      };
    } catch (err) {
      return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: err.message }) };
    }
  }

  // ─── SEARCH BY MOBILE ─────────────────────────────────────
  if (action === 'searchByMobile') {
    const { mobile, columnMap } = body;
    if (!mobile || !columnMap) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing mobile or columnMap' }) };
    }

    try {
      const res = await fetch(`${SS_BASE}/sheets/${sheetId}?includeAll=true`, {
        headers: ssHeaders,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || 'Failed to fetch sheet');

      const mobileColId = String(columnMap['MOBILE'] || '');
      const matchingRows = (data.rows || []).filter(row => {
        const cell = row.cells.find(c => String(c.columnId) === mobileColId);
        return cell && String(cell.value || '').replace(/\s+/g, '') === mobile.replace(/\s+/g, '');
      });

      const quotes = matchingRows.map(row => {
        const cell = k => {
          const c = row.cells.find(c2 => String(c2.columnId) === String(columnMap[k] || ''));
          return c ? c.value : null;
        };
        return {
          rowId:      row.id,
          date:       cell('DATE'),
          series:     cell('SERIES'),
          model:      cell('MODEL'),
          name:       cell('CUSTOMER_NAME'),
          email:      cell('EMAIL'),
          mobile:     cell('MOBILE'),
          postcode:   cell('POSTCODE'),
          grandTotal: cell('GRAND_TOTAL'),
          quoteJson:  cell('QUOTE_JSON'),
        };
      });

      return { statusCode: 200, headers, body: JSON.stringify({ quotes }) };
    } catch (err) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
    }
  }

  // ─── SAVE QUOTE ───────────────────────────────────────────
  if (action === 'saveQuote') {
    const { quote, columnMap, rowId, appUrl } = body;
    if (!quote || !columnMap) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing quote or columnMap' }) };
    }

    try {
      const quoteB64  = Buffer.from(JSON.stringify(quote)).toString('base64');
      const quoteLink = appUrl ? `${appUrl}/?q=${encodeURIComponent(quoteB64)}` : '';
      const optsList  = (quote.items || []).map(it => `${it.name}${it.qty > 1 ? ' ×' + it.qty : ''}`).join(', ');

      const vals = {
        DATE:          quote.date,
        SERIES:        quote.series,
        MODEL:         quote.model,
        CUSTOMER_NAME: quote.customer?.name   || '',
        EMAIL:         quote.customer?.email  || '',
        MOBILE:        quote.customer?.mobile || '',
        POSTCODE:      quote.customer?.postcode || '',
        BASE_PRICE:    quote.base,
        OPTIONS_TOTAL: quote.optsTotal,
        DELIVERY:      quote.delivery,
        DISCOUNT:      quote.discount || 0,
        GRAND_TOTAL:   quote.grand,
        OPTIONS_LIST:  optsList,
        QUOTE_LINK:    quoteLink,
        QUOTE_JSON:    JSON.stringify(quote),
      };

      const cells = Object.keys(columnMap)
        .filter(k => columnMap[k] && vals[k] !== undefined)
        .map(k => ({ columnId: Number(columnMap[k]), value: vals[k] }));

      let res, result;

      if (rowId) {
        // Update existing row
        res = await fetch(`${SS_BASE}/sheets/${sheetId}/rows`, {
          method: 'PUT',
          headers: ssHeaders,
          body: JSON.stringify([{ id: rowId, cells }]),
        });
      } else {
        // Add new row at bottom
        res = await fetch(`${SS_BASE}/sheets/${sheetId}/rows`, {
          method: 'POST',
          headers: ssHeaders,
          body: JSON.stringify([{ toBottom: true, cells }]),
        });
      }

      result = await res.json();
      if (!res.ok) throw new Error(result.message || 'Smartsheet save failed');

      const savedRowId = rowId || (result.result && result.result[0] && result.result[0].id) || null;
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, rowId: savedRowId }) };
    } catch (err) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
    }
  }

  return { statusCode: 400, headers, body: JSON.stringify({ error: `Unknown action: ${action}` }) };
};
