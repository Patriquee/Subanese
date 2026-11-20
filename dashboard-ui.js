/* Pure calculations and rendering for the authenticated admin dashboard. */
function dashboardModel(allOrders, finance, filters={}, now=new Date()) {
 const day=date=>new Intl.DateTimeFormat('en-CA',{timeZone:'Africa/Nairobi',year:'numeric',month:'2-digit',day:'2-digit'}).format(date);
 const today=Date.parse(day(now)+'T00:00:00+03:00');
 const period=[0,7,30,90].includes(filters.period)?filters.period:30;
 const query=String(filters.query||'').trim().toLowerCase();
 const matches=order=>(!filters.method||order.method===filters.method)&&(!filters.status||order.status===filters.status)&&(!query||(order.id+' '+order.name).toLowerCase().includes(query));
 const eligible=allOrders.filter(matches).filter(order=>Number.isFinite(Date.parse(order.created))&&Date.parse(order.created)<=+now);
 const earliest=eligible.reduce((min,order)=>Math.min(min,Date.parse(day(new Date(order.created))+'T00:00:00+03:00')),today);
 const start=period?today-(period-1)*86400000:earliest;
 const days=Math.round((today-start)/86400000)+1;
 const orders=eligible.filter(order=>Date.parse(order.created)>=start);
 const prior=period?eligible.filter(order=>Date.parse(order.created)<start&&Date.parse(order.created)>=start-period*86400000):[];
 const live=list=>list.filter(order=>order.status!=='cancelled');
 const sum=(list,key)=>list.reduce((total,row)=>total+Number(row[key]||0),0);
 const orderValue=list=>sum(live(list),'total');
 const ids=new Set(orders.map(order=>order.id));
 const payments=(finance?.records?.payments||[]).filter(payment=>ids.has(payment.order_id));
 const received=payments.filter(payment=>payment.status==='succeeded');
 const receivedIds=new Set(received.map(payment=>payment.id));
 const refunds=(finance?.records?.refunds||[]).filter(refund=>receivedIds.has(refund.payment_id));
 const receivedAmount=sum(received,'amount_minor')/100,refundAmount=sum(refunds,'amount_minor')/100;
 const paid=new Map();received.forEach(payment=>paid.set(payment.order_id,(paid.get(payment.order_id)||0)+payment.amount_minor/100));
 const refunded=new Map();refunds.forEach(refund=>{const payment=received.find(p=>p.id===refund.payment_id);refunded.set(payment.order_id,(refunded.get(payment.order_id)||0)+refund.amount_minor/100);});
 const unpaid=live(orders).filter(order=>(paid.get(order.id)||0)<order.total);
 const outstanding=unpaid.reduce((total,order)=>total+Math.max(0,order.total-(paid.get(order.id)||0)),0);
 const fields={reference:order=>!!order.id,created:order=>Number.isFinite(Date.parse(order.created)),amount:order=>Number.isFinite(order.total)&&order.total>=0,customer:order=>!!String(order.name||'').trim(),status:order=>!!order.status,fulfillment:order=>['pickup','delivery'].includes(order.method)};
 const quality=Object.entries(fields).map(([label,valid])=>({label,count:orders.filter(valid).length,percent:orders.length?orders.filter(valid).length/orders.length*100:0}));
 const incomplete=orders.filter(order=>Object.values(fields).some(valid=>!valid(order)));
 let group=['day','week','month'].includes(filters.group)?filters.group:'day';
 // Bound rendering for long histories without dropping any orders.
 if(group==='day'&&days>120)group='week';if(group==='week'&&days>840)group='month';
 const bucketKey=date=>{const key=day(date);if(group==='month')return key.slice(0,7);if(group==='week'){const t=Date.parse(key+'T00:00:00+03:00'),weekday=new Date(t+10800000).getUTCDay();return day(new Date(t-((weekday+6)%7)*86400000));}return key;};
 const map=new Map();
 for(let t=start;t<=today;t+=86400000){const key=bucketKey(new Date(t));if(!map.has(key))map.set(key,{label:key,count:0,value:0,completed:0,cancelled:0,covered:0,unpaid:0,receipts:0,outstandingValue:0});}
 orders.forEach(order=>{const bucket=map.get(bucketKey(new Date(order.created)));bucket.count++;bucket.receipts+=paid.get(order.id)||0;if(order.status==='cancelled')bucket.cancelled++;else{bucket.value+=order.total;bucket.outstandingValue+=Math.max(0,order.total-(paid.get(order.id)||0));bucket[paid.get(order.id)>=order.total?'covered':'unpaid']++;}if(order.status==='completed')bucket.completed++;});
 const top=new Map();live(orders).forEach(order=>(order.items||[]).forEach(item=>{const row=top.get(item.id)||{name:item.name,quantity:0,value:0};row.quantity+=item.quantity;row.value+=item.quantity*item.price;top.set(item.id,row);}));
 const cancelled=orders.filter(order=>order.status==='cancelled');
 return{paidByOrder:paid,active:orders.filter(order=>!['completed','cancelled'].includes(order.status)).length,awaiting:orders.filter(order=>order.status==='confirmed'),lowStock:products.filter(product=>product.stock<=5),orders,prior,period,group,metric:filters.metric==='count'?'count':'value',buckets:[...map.values()],quality,incompleteIds:incomplete.map(o=>o.id),unpaidIds:unpaid.map(o=>o.id),outstanding,received:receivedAmount,refunds:refundAmount,net:receivedAmount-refundAmount,paymentCount:payments.length,failed:payments.filter(p=>p.status==='failed'),pending:payments.filter(p=>p.status==='pending'),value:orderValue(orders),priorValue:orderValue(prior),completed:orders.filter(o=>o.status==='completed').length,completion:live(orders).length?orders.filter(o=>o.status==='completed').length/live(orders).length*100:0,cancelled:cancelled.length,cancelledValue:sum(cancelled,'total'),covered:live(orders).length-unpaid.length,coverage:live(orders).length?(live(orders).length-unpaid.length)/live(orders).length*100:0,cancelledUnrefunded:cancelled.reduce((total,order)=>total+Math.max(0,(paid.get(order.id)||0)-(refunded.get(order.id)||0)),0),topQuantity:[...top.values()].sort((a,b)=>b.quantity-a.quantity||b.value-a.value).slice(0,5),top:[...top.values()].sort((a,b)=>b.value-a.value).slice(0,5),invalidDates:allOrders.filter(matches).filter(o=>!Number.isFinite(Date.parse(o.created))).length};
}
function renderAnalyticsAgentReport(report) {
 const count = new Intl.NumberFormat();
 const currency = new Intl.NumberFormat('en-KE', { style: 'currency', currency: report.currency });
 const money = value => currency.format(value / report.minorUnit);
 const period = (label, row) => '<tr><th scope="row">' + label + '</th><td>' +
   escapeHTML(row.start) + ' to ' + escapeHTML(row.end) + '</td><td>' + count.format(row.orders) +
   '</td><td>' + count.format(row.cancelled) + '</td><td>' + money(row.order_value_minor) +
   '</td><td>' + count.format(row.registrations) + '</td></tr>';
 const financeLabels = {
   sales: 'Order value', received: 'Recorded receipts', refunded: 'Refunds', netCollections: 'Net collections',
   expenses: 'Net expenses', cashSurplus: 'Cash surplus', outstanding: 'Outstanding order value',
   wasteCost: 'Waste cost', productionCost: 'Production cost'
 };
 const metric = (label, value) => '<div><dt>' + label + '</dt><dd>' + value + '</dd></div>';
 return '<section class="analytics-panel"><h3>Source figures</h3><p>Order and registration dates use Nairobi time. Order value excludes cancellations.</p>' +
   '<div class="table"><table><thead><tr><th scope="col">Period</th><th scope="col">Dates</th><th scope="col">Orders</th>' +
   '<th scope="col">Cancelled</th><th scope="col">Order value</th><th scope="col">Registrations</th></tr></thead><tbody>' +
   period('Selected', report.current) + period('Previous', report.previous) + '</tbody></table></div>' +
   '<h4>All-time customer counts</h4><dl>' + metric('Registered users', count.format(report.usersAllTime.registered)) +
   metric('Customers with orders', count.format(report.usersAllTime.orderingCustomers)) +
   metric('Repeat customers', count.format(report.usersAllTime.repeatCustomers)) + '</dl>' +
   '<h4>All-time finance totals</h4><dl>' + Object.entries(financeLabels).map(([key, label]) =>
     metric(label, money(report.financeAllTimeMinor[key]))).join('') + '</dl></section>';
}

function renderUserAnalysis({ total, recent, genders, locations }) {
 const count = new Intl.NumberFormat();
 const metric = (label, value) => '<article class="analytics-kpi"><p>' + label + '</p><strong>' +
   count.format(value) + '</strong></article>';
 const breakdown = (title, column, rows, empty) => '<section class="analytics-panel"><h3>' + title + '</h3>' +
   (rows.length ? '<div class="table"><table><thead><tr><th scope="col">' + column +
     '</th><th scope="col">Users</th></tr></thead><tbody>' + rows.map(row =>
       '<tr><th scope="row">' + escapeHTML(row.label ?? 'Not provided') + '</th><td>' +
       count.format(row.count) + '</td></tr>'
     ).join('') + '</tbody></table></div>' : '<p class="analytics-empty">' + empty + '</p>') + '</section>';
 return '<div class="analytics-kpis">' + metric('Registered users', total) +
   metric('New registrations in the last 30 days (Nairobi time)', recent) + '</div>' +
   '<div class="analytics-main-grid">' + breakdown('Users by gender', 'Gender', genders, 'No registrations yet.') +
   breakdown('Top 10 reported locations', 'Location', locations, 'No locations have been provided.') + '</div>';
}

function renderAnalytics(model) {
 const esc=escapeHTML,fmt=money;
 const percent=value=>value.toFixed(1)+'%';
 const spark=(values,color='blue')=>{const max=Math.max(1,...values);return '<svg class="analytics-spark '+color+'" viewBox="0 0 100 30" aria-hidden="true"><polyline points="'+values.map((value,index)=>(index*100/Math.max(1,values.length-1))+','+(27-value/max*24)).join(' ')+'"/></svg>';};
 const compare=(value,prior)=>!model.period?'All time':prior?((value-prior)/prior*100).toFixed(1)+'% vs prior period':'No prior-period baseline';
 const card=(title,value,note,values,color='blue')=>'<article class="analytics-kpi"><p>'+title+'</p><strong>'+value+'</strong><small>'+note+'</small>'+spark(values,color)+'</article>';
 const alerts=[];
 if(model.outstanding)alerts.push(['warning','Outstanding order value',fmt(model.outstanding),'Not fully covered by recorded received payments.']);
 if(model.failed.length)alerts.push(['danger','Failed payments',String(model.failed.length),'Recorded payment attempts marked failed.']);
 if(model.cancelledUnrefunded)alerts.push(['danger','Cancelled orders with unrefunded receipts',fmt(model.cancelledUnrefunded),'Review payments and recorded refunds before taking action.']);
 if(!model.paymentCount)alerts.push(['neutral','Payment records unavailable','No records','Order totals are not confirmed collections.']);
 if(model.incompleteIds.length||model.invalidDates)alerts.push(['warning','Data needs attention',String(model.incompleteIds.length+model.invalidDates),'Incomplete orders or excluded invalid dates.']);
 const statusEntries=[...new Set(model.orders.map(o=>o.status))].map(status=>({label:status,value:model.orders.filter(o=>o.status===status).reduce((sum,o)=>sum+o.total,0),count:model.orders.filter(o=>o.status===status).length}));
 const bars=(entries,currency=true)=>{const total=Math.max(1,entries.reduce((sum,e)=>sum+e.value,0));return entries.length?'<ul class="analytics-bars">'+entries.map((entry,index)=>'<li><div><span><i class="analytics-dot tone-'+index%5+'"></i>'+esc(entry.label)+'</span><b>'+(currency?fmt(entry.value):entry.value)+'</b></div><div class="analytics-track"><span class="tone-'+index%5+'" style="width:'+entry.value/total*100+'%"></span></div>'+(entry.count!==undefined?'<small>'+entry.count+' orders</small>':'')+'</li>').join('')+'</ul>':'<p class="analytics-empty">No records for these filters.</p>';};
 const panel=(title,subtitle,body,extra='')=>'<section class="analytics-panel '+extra+'"><div class="analytics-panel-heading"><div><h3>'+title+'</h3><p>'+subtitle+'</p></div></div>'+body+'</section>';
 function trend(){const buckets=model.buckets,max=Math.max(1,...buckets.map(b=>b[model.metric])),format=value=>model.metric==='count'?String(Math.round(value)):fmt(value);const x=i=>65+i*690/Math.max(1,buckets.length-1),y=value=>205-value/max*160;
 return '<svg class="analytics-trend" viewBox="0 0 800 250" role="img" aria-label="Order '+(model.metric==='count'?'volume':'value')+' trend"><title>Order trend grouped by '+model.group+'</title>'+[0,.25,.5,.75,1].map(f=>'<line x1="65" x2="755" y1="'+y(f*max)+'" y2="'+y(f*max)+'"/><text x="55" y="'+(y(f*max)+4)+'" text-anchor="end">'+esc(format(f*max))+'</text>').join('')+'<polyline class="analytics-line" points="'+buckets.map((b,i)=>x(i)+','+y(b[model.metric])).join(' ')+'"/>'+buckets.map((b,i)=>'<circle cx="'+x(i)+'" cy="'+y(b[model.metric])+'" r="3"><title>'+b.label+': '+esc(format(b[model.metric]))+'</title></circle>').join('')+[...new Set([0,Math.floor((buckets.length-1)/2),buckets.length-1])].map(i=>'<text x="'+x(i)+'" y="237" text-anchor="middle">'+buckets[i].label+'</text>').join('')+'</svg><details class="analytics-data"><summary>View trend data</summary><div class="table"><table><thead><tr><th>Period</th><th>Orders</th><th>Order value</th></tr></thead><tbody>'+buckets.map(b=>'<tr><td>'+b.label+'</td><td>'+b.count+'</td><td>'+fmt(b.value)+'</td></tr>').join('')+'</tbody></table></div></details>';}
 function coverage(){const buckets=model.buckets,max=Math.max(1,...buckets.map(b=>b.covered+b.unpaid)),step=690/Math.max(1,buckets.length),width=Math.max(2,Math.min(20,step*.65));return '<svg class="analytics-trend" viewBox="0 0 800 220" role="img" aria-label="Orders covered by recorded payments compared with outstanding orders"><title>Payment coverage by order creation date</title>'+[0,.5,1].map(f=>'<line x1="60" x2="755" y1="'+(175-f*130)+'" y2="'+(175-f*130)+'"/><text x="45" y="'+(179-f*130)+'" text-anchor="end">'+Math.round(max*f)+'</text>').join('')+buckets.map((b,i)=>{const x=65+i*step,good=b.covered/max*130,bad=b.unpaid/max*130;return '<g><rect class="analytics-paid" x="'+x+'" y="'+(175-good)+'" width="'+width+'" height="'+good+'"/><rect class="analytics-unpaid" x="'+x+'" y="'+(175-good-bad)+'" width="'+width+'" height="'+bad+'"/><title>'+b.label+': '+b.covered+' covered, '+b.unpaid+' outstanding</title></g>';}).join('')+'<text x="65" y="205">'+buckets[0].label+'</text><text x="755" y="205" text-anchor="end">'+buckets.at(-1).label+'</text></svg><p class="analytics-legend"><span class="analytics-dot tone-1"></span> Fully covered <span class="analytics-dot tone-2"></span> Outstanding</p>';}
 const exceptionButton=(kind,label,count,value)=>'<button type="button" class="analytics-exception" data-dashboard-exception="'+kind+'"><span>'+label+'<small>'+count+' orders</small></span><strong>'+fmt(value)+'</strong><span aria-hidden="true">&rarr;</span></button>';
 return '<div class="analytics-source"><span>Source: Subanese order and manual finance records</span><span>'+model.orders.length+' filtered orders</span></div>'+(!model.orders.length?'<p class="notice">No orders match these filters. Reset the filters or select a different period.</p>':'')+'<div class="analytics-alerts">'+alerts.map(([tone,title,value,note])=>'<article class="analytics-alert '+tone+'"><div><strong>'+title+'</strong><p>'+note+'</p></div><b>'+value+'</b></article>').join('')+'</div><div class="analytics-kpis">'+
 card('Order value',fmt(model.value),compare(model.value,model.priorValue),model.buckets.map(b=>b.value))+card('Received payments',fmt(model.received),'Selected orders, recorded to date',model.buckets.map(b=>b.receipts),'green')+card('Outstanding balance',fmt(model.outstanding),model.unpaidIds.length+' orders not fully covered',model.buckets.map(b=>b.outstandingValue),'orange')+card('Active orders',model.active,'Selected orders still in progress',model.buckets.map(b=>b.count-b.completed-b.cancelled))+card('Refunds',fmt(model.refunds),'Selected orders, recorded to date',[],'orange')+card('Low-stock items',model.lowStock.length,'Current inventory; independent of order filters',[])+'</div><p class="analytics-scope">Order value excludes cancellations and includes delivery. Payment figures cover the selected orders and all their recorded payments to date, not cash received only within this period. Manual payment confirmation is not external reconciliation.</p><div class="analytics-main-grid">'+panel('Sales trend','Grouped by '+model.group+' / '+(model.metric==='count'?'Order count':'Order value')+' / Nairobi time',trend())+panel('Order-status breakdown','Share of selected order value, including cancelled orders',bars(statusEntries))+'</div><div class="analytics-main-grid">'+panel('Payment coverage','Selected orders by creation date; recorded receipts, not external reconciliation',coverage())+'</div><div class="analytics-main-grid">'+panel('Most purchased items by quantity','Top 5 by units ordered; excludes cancelled orders',bars(model.topQuantity.map(row=>({label:row.name,value:row.quantity})),false))+panel('Most purchased items by value','Top 5 by item sales value; excludes delivery and cancelled orders',bars(model.top.map(row=>({label:row.name,value:row.value}))))+'</div>'+renderMarketingAnalysis(model)+'<details class="analytics-panel dashboard-diagnostics"><summary>Record quality &amp; exceptions</summary>'+exceptionButton('unpaid','Outstanding orders',model.unpaidIds.length,model.outstanding)+exceptionButton('cancelled','Cancelled orders',model.cancelled,model.cancelledValue)+exceptionButton('incomplete','Incomplete order records',model.incompleteIds.length,model.orders.filter(o=>model.incompleteIds.includes(o.id)).reduce((sum,o)=>sum+o.total,0))+'<p class="analytics-scope">Invalid dates excluded: '+model.invalidDates+'. No fraud or reconciliation scores are inferred.</p></details><div id="analytics-investigation"></div>';
}


function renderAdminHome(data, inventory, now=new Date()) {
 const esc=escapeHTML;
 const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Africa/Nairobi',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
 const active=data.ordersForHome || data.analytics || data.orders || [];
 const live=active.filter(order=>!['completed','cancelled'].includes(order.status));
 const due=live.filter(order=>order.date===today);
 const overdue=live.filter(order=>order.date&&order.date<today);
 const preparation=live.filter(order=>['confirmed','preparing'].includes(order.status)).sort((a,b)=>String(a.date||'9999').localeCompare(String(b.date||'9999'))).slice(0,8);
 const dispatch=live.filter(order=>['ready','out for delivery'].includes(order.status)).slice(0,8);
 const stock=inventory.filter(product=>product.stock<=5).sort((a,b)=>a.stock-b.stock);
 const counter=(label,value)=>'<div class="home-counter"><strong>'+value+'</strong><span>'+label+'</span></div>';
 const orders=list=>list.length?'<ul class="dashboard-action-list">'+list.map(order=>'<li><a href="#/admin?view=orders&order='+encodeURIComponent(order.id)+'"><span><strong>'+esc(order.id)+'</strong><small>'+esc(order.name)+' / '+esc(order.date)+' / '+esc(order.method)+'</small></span><b>'+esc(order.status)+'</b><span aria-hidden="true">&rarr;</span></a></li>').join('')+'</ul>':'<p class="analytics-empty">Nothing waiting in this queue.</p>';
 const panel=(title,copy,body)=>'<section class="analytics-panel"><h3>'+title+'</h3><p class="home-panel-copy">'+copy+'</p>'+body+'</section>';
 return '<div class="home-heading"><span class="eyebrow">Your bakery workbench</span><h2>Ready for the day.</h2><p>'+esc(new Intl.DateTimeFormat('en-GB',{timeZone:'Africa/Nairobi',weekday:'long',day:'numeric',month:'long',year:'numeric'}).format(now))+' / Nairobi</p></div><div class="home-counters">'+counter('Active orders',live.length)+counter('Scheduled today',due.length)+counter('Ready or out for delivery',live.filter(order=>['ready','out for delivery'].includes(order.status)).length)+counter('Sold-out items',inventory.filter(product=>product.stock===0).length)+'</div>'+(overdue.length?'<p class="home-attention">'+overdue.length+' active orders have a fulfillment date before today. Review the preparation and dispatch queues.</p>':'')+'<nav class="home-shortcuts" aria-label="Bakery quick actions"><a class="btn secondary" href="#/admin?view=items&add=1">Add item</a><a class="btn secondary" href="#/admin?view=finance&record=payments">Record payment</a><a class="btn secondary" href="#/admin?view=finance&record=expenses">Record expense</a><a class="btn secondary" href="#/admin?view=orders">Manage orders</a></nav><div class="home-operations">'+panel('Preparation queue','Up to 8 confirmed or preparing orders, earliest date first.',orders(preparation))+panel('Pickup & delivery queue','Ready orders and orders out for delivery. Up to 8 shown.',orders(dispatch))+'</div>'+panel('Stock to replenish','Current items with five or fewer available.',stock.length?'<ul class="home-stock-list">'+stock.slice(0,8).map(product=>'<li><a href="#/admin?view=items&product='+encodeURIComponent(product.id)+'"><span>'+esc(product.name)+'</span><strong>'+product.stock+' left</strong></a></li>').join('')+'</ul><a class="text-link" href="#/admin?view=items">View inventory &rarr;</a>':'<p class="analytics-empty">No low-stock products.</p>')+'<p class="home-analytics-link">Need sales and financial reporting? <a href="#/admin?view=dashboard">Open Analytics &rarr;</a></p>';
}


function marketingAnalysis(orders, {period=30, holidays=[], now=new Date()}={}) {
 const dayFormat=new Intl.DateTimeFormat('en-CA',{timeZone:'Africa/Nairobi',year:'numeric',month:'2-digit',day:'2-digit'});
 const hourFormat=new Intl.DateTimeFormat('en-GB',{timeZone:'Africa/Nairobi',hour:'2-digit',hourCycle:'h23'});
 const today=dayFormat.format(now),holidaySet=new Set(holidays);
 const valid=orders.filter(order=>Number.isFinite(Date.parse(order.created))&&Date.parse(order.created)<=+now);
 const start=period?Date.parse(today+'T00:00:00Z')-(period-1)*86400000:Math.min(Date.parse(today+'T00:00:00Z'),...valid.map(order=>Date.parse(dayFormat.format(new Date(order.created))+'T00:00:00Z')));
 const row=label=>({label,count:0,value:0,days:0});
 const weekdays=['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'].map(row);
 const hours=Array.from({length:5},(_,index)=>row(String(index*5).padStart(2,'0')+':00\u2013'+String(Math.min(24,(index+1)*5)).padStart(2,'0')+':00'));
 const types=[row('Weekdays'),row('Weekends')],holidayTypes=[row('Configured holidays'),row('Other days')],quarters=new Map();
 const quarter=date=>date.slice(0,4)+' Q'+Math.ceil(Number(date.slice(5,7))/3);
 for(let time=start;time<=Date.parse(today+'T00:00:00Z');time+=86400000){
  const date=new Date(time),key=date.toISOString().slice(0,10),weekday=date.getUTCDay();
  weekdays[weekday].days++;types[weekday===0||weekday===6?1:0].days++;holidayTypes[holidaySet.has(key)?0:1].days++;
  const q=quarter(key);if(!quarters.has(q))quarters.set(q,row(q));quarters.get(q).days++;
 }
 let cancelled=0;
 for(const order of valid){
  const date=new Date(order.created),key=dayFormat.format(date);
  if(Date.parse(key+'T00:00:00Z')<start)continue;
  if(order.status==='cancelled'){cancelled++;continue;}
  const weekday=new Date(key+'T00:00:00Z').getUTCDay();
  for(const target of [weekdays[weekday],hours[Math.floor(Number(hourFormat.format(date))/5)],types[weekday===0||weekday===6?1:0],holidayTypes[holidaySet.has(key)?0:1],quarters.get(quarter(key))]){target.count++;target.value+=order.total;}
 }
 return {weekdays:[...weekdays.slice(1),weekdays[0]],hours,types,holidayTypes,quarters:[...quarters.values()],cancelled};
}
function renderMarketingAnalysis(model) {
 const data=marketingAnalysis(model.orders,{period:model.period,holidays:model.marketingHolidays||[]});
 const table=(rows,normalise=true)=>{
  const max=Math.max(1,...rows.map(row=>row.count));
  return '<div class="table"><table><thead><tr><th>Timing</th><th>Orders</th><th>Order value</th>'+(normalise?'<th>Orders / calendar day</th>':'')+'</tr></thead><tbody>'+rows.map(row=>'<tr><td>'+escapeHTML(row.label)+'</td><td>'+row.count+'<div class="analytics-track"><span class="tone-1" style="width:'+row.count/max*100+'%"></span></div></td><td>'+money(row.value)+'</td>'+(normalise?'<td>'+(row.days?(row.count/row.days).toFixed(2):'?')+'</td>':'')+'</tr>').join('')+'</tbody></table></div>';
 };
 const panel=(title,body)=>'<section class="analytics-panel"><h3>'+title+'</h3>'+body+'</section>';
 const peak=[...data.hours].sort((a,b)=>b.count-a.count)[0];
 return '<section class="marketing-analysis"><h2>Marketing &amp; order timing</h2><p class="analytics-scope">Based on order placement in Nairobi time and current dashboard filters. Cancelled orders excluded. Order value is not collected revenue. Calendar-day averages include days with no orders; quarterly totals may cover partial quarters. Visitor traffic and campaign sources are not tracked.</p>'+(peak.count?'<p>Most orders were placed during <strong>'+peak.label+'</strong> ('+peak.count+' orders). Use observed patterns to plan campaign timing.</p>':'<p>No orders available for timing analysis.</p>')+'<div class="analytics-main-grid">'+panel('Orders by five-hour interval',table(data.hours,false))+panel('Orders by day of week',table(data.weekdays))+'</div><div class="analytics-main-grid">'+panel('Weekdays vs weekends',table(data.types))+panel('Quarterly analysis',table(data.quarters))+'</div>'+panel('Holiday analysis',(model.marketingHolidays?.length?'<p>Only explicitly configured holiday dates are classified as holidays.</p>'+table(data.holidayTypes):'<p>No holiday calendar configured. Set MARKETING_HOLIDAYS to comma-separated dates (YYYY-MM-DD), including observed or campaign holidays, then restart the server.</p>'))+'</section>';
}
