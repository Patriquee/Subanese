const {randomUUID}=require('node:crypto');
const categories=['ingredients','packaging','wages','rent','utilities','delivery','marketing','other'];
function createFinance(db,{currency='KES',deliveryFee=350}={}){
 const fail=message=>{throw Object.assign(Error(message),{status:400});};
 const str=(value,label,max=200)=>{if(typeof value!=='string'||!value.trim()||value.length>max)fail('Enter a valid '+label+'.');return value.trim();};
 const amount=(value,zero=false)=>{if(!Number.isSafeInteger(value)||value<(zero?0:1)||value>100000000000)fail('Enter a valid amount in minor currency units.');return value;};
 const count=value=>{if(!Number.isSafeInteger(value)||value<1||value>100000)fail('Enter a valid quantity.');return value;};
 const date=value=>{const result=str(value,'date',10);if(!/^\d{4}-\d{2}-\d{2}$/.test(result)||!Number.isFinite(Date.parse(result))||new Date(result).toISOString().slice(0,10)!==result||result>new Intl.DateTimeFormat('en-CA',{timeZone:'Africa/Nairobi',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date()))fail('Choose a valid date, no later than today.');return result;};
 db.exec(`
 CREATE TABLE IF NOT EXISTS finance_orders(order_id TEXT PRIMARY KEY,customer_id TEXT,created TEXT,subtotal_minor INTEGER NOT NULL,discount_minor INTEGER NOT NULL,delivery_minor INTEGER NOT NULL,total_minor INTEGER NOT NULL,breakdown_source TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS finance_order_items(order_id TEXT NOT NULL,line INTEGER NOT NULL,product_id INTEGER,name TEXT,quantity INTEGER,unit_price_minor INTEGER,size TEXT,customization_minor INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(order_id,line));
 CREATE TABLE IF NOT EXISTS finance_payments(id TEXT PRIMARY KEY,order_id TEXT NOT NULL,amount_minor INTEGER NOT NULL,method TEXT NOT NULL,reference TEXT NOT NULL UNIQUE,date TEXT NOT NULL,status TEXT NOT NULL,source TEXT NOT NULL DEFAULT 'manual',created TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS finance_payment_events(id INTEGER PRIMARY KEY,payment_id TEXT NOT NULL,status TEXT NOT NULL,reference TEXT NOT NULL UNIQUE,created TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS finance_refunds(id TEXT PRIMARY KEY,payment_id TEXT NOT NULL,amount_minor INTEGER NOT NULL,date TEXT NOT NULL,reason TEXT NOT NULL,reference TEXT NOT NULL UNIQUE,created TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS finance_expenses(id TEXT PRIMARY KEY,amount_minor INTEGER NOT NULL,date TEXT NOT NULL,category TEXT NOT NULL,supplier TEXT NOT NULL,reference TEXT NOT NULL UNIQUE,note TEXT NOT NULL,reverse_of TEXT UNIQUE,created TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS finance_batches(id TEXT PRIMARY KEY,product_id INTEGER NOT NULL,batch TEXT NOT NULL UNIQUE,quantity INTEGER NOT NULL,ingredient_minor INTEGER NOT NULL,packaging_minor INTEGER NOT NULL,date TEXT NOT NULL,created TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS finance_waste(id TEXT PRIMARY KEY,product_id INTEGER,batch_id TEXT,quantity INTEGER NOT NULL,reason TEXT NOT NULL,cost_minor INTEGER NOT NULL,date TEXT NOT NULL,reference TEXT NOT NULL UNIQUE,created TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS finance_stock_changes(id INTEGER PRIMARY KEY,product_id INTEGER,change INTEGER,stock_after INTEGER,created TEXT);
 CREATE TRIGGER IF NOT EXISTS finance_stock_update AFTER UPDATE OF stock ON products WHEN OLD.stock != NEW.stock BEGIN INSERT INTO finance_stock_changes(product_id,change,stock_after,created) VALUES(NEW.id,NEW.stock-OLD.stock,NEW.stock,strftime('%Y-%m-%dT%H:%M:%fZ','now')); END;
 CREATE TRIGGER IF NOT EXISTS finance_stock_insert AFTER INSERT ON products BEGIN INSERT INTO finance_stock_changes(product_id,change,stock_after,created) VALUES(NEW.id,NEW.stock,NEW.stock,strftime('%Y-%m-%dT%H:%M:%fZ','now')); END;
 `);
 // Existing stock is a documented opening balance, never inferred historical production.
 if(!db.prepare('SELECT 1 FROM finance_stock_changes LIMIT 1').get())db.prepare("INSERT INTO finance_stock_changes(product_id,change,stock_after,created) SELECT id,stock,stock,? FROM products").run(new Date().toISOString());
 function capture(orderId,legacy=false){
  if(db.prepare('SELECT 1 FROM finance_orders WHERE order_id=?').get(orderId))return;
  const order=db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);if(!order)return;
  const items=JSON.parse(order.items);const subtotal=items.reduce((sum,item)=>sum+item.price*item.quantity,0)*100;
  const total=order.total*100,delivery=legacy?Math.max(0,total-subtotal):(order.method==='delivery'?deliveryFee*100:0);
  db.prepare('INSERT INTO finance_orders VALUES(?,?,?,?,?,?,?,?)').run(order.id,order.customer_id||null,order.created,subtotal,Math.max(0,subtotal+delivery-total),delivery,total,legacy?'legacy-derived':'checkout');
  const insert=db.prepare('INSERT INTO finance_order_items VALUES(?,?,?,?,?,?,?,?)');
  items.forEach((item,index)=>insert.run(order.id,index,item.id,item.name,item.quantity,item.price*100,item.size||null,Number(item.customization_minor)||0));
 }
 for(const order of db.prepare('SELECT id FROM orders').all())capture(order.id,true);
 function paymentStatus(id){return db.prepare('SELECT status FROM finance_payment_events WHERE payment_id=? ORDER BY id DESC LIMIT 1').get(id)?.status || db.prepare('SELECT status FROM finance_payments WHERE id=?').get(id)?.status;}
 function record(kind,input){
  const id=randomUUID(),created=new Date().toISOString();
  db.exec('BEGIN IMMEDIATE');
  try{
   if(kind==='payments'){
    const order=db.prepare('SELECT * FROM orders WHERE id=?').get(str(input.order_id,'order reference'));
    if(!order||order.status==='cancelled')fail('Choose an existing non-cancelled order.');
    const status=input.status||'pending';if(!['pending','succeeded','failed'].includes(status))fail('Choose a payment status.');
    const method=str(input.method,'payment method',40);if(!['mpesa','cash','card','bank'].includes(method))fail('Choose a payment method.');
    db.prepare('INSERT INTO finance_payments VALUES(?,?,?,?,?,?,?,?,?)').run(id,order.id,amount(input.amount_minor),method,str(input.reference,'unique payment reference'),date(input.date),status,'manual',created);
   }else if(kind==='payment-events'){
    const payment=db.prepare('SELECT * FROM finance_payments WHERE id=?').get(str(input.payment_id,'payment ID'));
    if(!payment || paymentStatus(payment.id)!=='pending' || !['succeeded','failed'].includes(input.status))fail('Only pending payments can be confirmed or failed.');
    db.prepare('INSERT INTO finance_payment_events(payment_id,status,reference,created) VALUES(?,?,?,?)').run(payment.id,input.status,str(input.reference,'confirmation reference'),created);
   }else if(kind==='refunds'){
    const payment=db.prepare("SELECT * FROM finance_payments WHERE id=?").get(str(input.payment_id,'payment ID'));
    if(!payment || paymentStatus(payment.id)!=='succeeded')fail('Choose a received payment.');
    const refunded=db.prepare('SELECT COALESCE(SUM(amount_minor),0) AS total FROM finance_refunds WHERE payment_id=?').get(payment.id).total;
    if(amount(input.amount_minor)>payment.amount_minor-refunded)fail('Refund exceeds the unrefunded payment amount.');
    db.prepare('INSERT INTO finance_refunds VALUES(?,?,?,?,?,?,?)').run(id,payment.id,input.amount_minor,date(input.date),str(input.reason,'refund reason',1000),str(input.reference,'unique refund reference'),created);
   }else if(kind==='expenses'){
    if(!categories.includes(input.category))fail('Choose an expense category.');
    db.prepare('INSERT INTO finance_expenses VALUES(?,?,?,?,?,?,?,?,?)').run(id,amount(input.amount_minor),date(input.date),input.category,str(input.supplier,'supplier'),str(input.reference,'receipt reference'),typeof input.note==='string'?input.note.slice(0,1000):'',null,created);
   }else if(kind==='expense-reversals'){
    const original=db.prepare('SELECT * FROM finance_expenses WHERE id=? AND reverse_of IS NULL').get(str(input.expense_id,'expense ID'));
    if(!original)fail('Choose an original expense.');
    db.prepare('INSERT INTO finance_expenses VALUES(?,?,?,?,?,?,?,?,?)').run(id,-original.amount_minor,date(input.date),original.category,original.supplier,str(input.reference,'correction reference'),str(input.reason,'correction reason',1000),original.id,created);
   }else if(kind==='batches'){
    const product=db.prepare('SELECT * FROM products WHERE id=? AND active=1').get(input.product_id);if(!product)fail('Choose an active product.');
    const quantity=count(input.quantity);if(product.stock+quantity>10000)fail('Stock cannot exceed 10,000.');
    db.prepare('INSERT INTO finance_batches VALUES(?,?,?,?,?,?,?,?)').run(id,product.id,str(input.batch,'unique batch reference'),quantity,amount(input.ingredient_minor,true),amount(input.packaging_minor,true),date(input.date),created);
    db.prepare('UPDATE products SET stock=stock+? WHERE id=?').run(quantity,product.id);
   }else if(kind==='waste'){
    const product=db.prepare('SELECT * FROM products WHERE id=?').get(input.product_id);if(!product)fail('Choose an existing product.');
    const quantity=count(input.quantity);if(product.stock<quantity)fail('Waste quantity exceeds available stock.');
    let batch=null;if(input.batch_id){batch=db.prepare('SELECT * FROM finance_batches WHERE id=? AND product_id=?').get(input.batch_id,product.id);if(!batch)fail('Batch does not match this product.');const used=db.prepare('SELECT COALESCE(SUM(quantity),0) total FROM finance_waste WHERE batch_id=?').get(batch.id).total;if(quantity+used>batch.quantity)fail('Waste exceeds the batch quantity.');}
    db.prepare('INSERT INTO finance_waste VALUES(?,?,?,?,?,?,?,?,?)').run(id,product.id,batch?.id||null,quantity,str(input.reason,'waste reason',1000),amount(input.cost_minor,true),date(input.date),str(input.reference,'unique waste reference'),created);
    db.prepare('UPDATE products SET stock=stock-? WHERE id=?').run(quantity,product.id);
   }else fail('Unknown finance record type.');
   db.exec('COMMIT');return{id};
  }catch(error){db.exec('ROLLBACK');if(error.code?.includes('CONSTRAINT') || /UNIQUE constraint failed/.test(error.message))fail('That reference or correction already exists. Use a unique reference.');throw error;}
 }
 const tables={orders:'finance_orders',items:'finance_order_items',payments:'finance_payments',paymentEvents:'finance_payment_events',refunds:'finance_refunds',expenses:'finance_expenses',batches:'finance_batches',waste:'finance_waste',stock:'finance_stock_changes'};
 function report(){
  const records=Object.fromEntries(Object.entries(tables).map(([key,table])=>[key,db.prepare('SELECT * FROM '+table).all()]));
  records.payments=records.payments.map(payment=>({...payment,status:paymentStatus(payment.id)}));
  const sum=(rows,key)=>rows.reduce((total,row)=>total+row[key],0);
  const orderStatuses=new Map(db.prepare('SELECT id,status FROM orders').all().map(o=>[o.id,o.status]));
  const sales=sum(records.orders.filter(o=>orderStatuses.get(o.order_id)!=='cancelled'),'total_minor');
  const received=sum(records.payments.filter(p=>p.status==='succeeded'),'amount_minor'),refunded=sum(records.refunds,'amount_minor'),expenses=sum(records.expenses,'amount_minor');
  const outstanding=records.orders.filter(o=>orderStatuses.get(o.order_id)!=='cancelled').reduce((total,o)=>total+Math.max(0,o.total_minor-sum(records.payments.filter(p=>p.order_id===o.order_id&&p.status==='succeeded'),'amount_minor')),0);
  const daily=new Map(),productPerformance=new Map(),customerCounts=new Map();
  for(const order of records.orders.filter(o=>orderStatuses.get(o.order_id)!=='cancelled')){
    const day=new Intl.DateTimeFormat('en-CA',{timeZone:'Africa/Nairobi',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(order.created));
    const row=daily.get(day)||{date:day,orders:0,sales_minor:0};row.orders++;row.sales_minor+=order.total_minor;daily.set(day,row);
    if(order.customer_id)customerCounts.set(order.customer_id,(customerCounts.get(order.customer_id)||0)+1);
  }
  for(const line of records.items.filter(item=>orderStatuses.get(item.order_id)!=='cancelled')){
    const row=productPerformance.get(line.product_id)||{product_id:line.product_id,name:line.name,quantity:0,sales_minor:0};row.quantity+=line.quantity;row.sales_minor+=line.unit_price_minor*line.quantity+line.customization_minor;productPerformance.set(line.product_id,row);
  }
  const analysis={dailySales:[...daily.values()].sort((a,b)=>a.date.localeCompare(b.date)),products:[...productPerformance.values()].sort((a,b)=>b.sales_minor-a.sales_minor),repeatCustomers:[...customerCounts.values()].filter(count=>count>1).length,orderingCustomers:customerCounts.size};
  return{currency,minorUnit:100,categories,analysis,summary:{sales,received,refunded,netCollections:received-refunded,expenses,cashSurplus:received-refunded-expenses,outstanding,wasteCost:sum(records.waste,'cost_minor'),productionCost:sum(records.batches,'ingredient_minor')+sum(records.batches,'packaging_minor')},records};
 }
 for(const table of Object.values(tables)){db.exec('CREATE TRIGGER IF NOT EXISTS '+table+'_no_update BEFORE UPDATE ON '+table+" BEGIN SELECT RAISE(ABORT, 'Financial records are immutable'); END;");db.exec('CREATE TRIGGER IF NOT EXISTS '+table+'_no_delete BEFORE DELETE ON '+table+" BEGIN SELECT RAISE(ABORT, 'Financial records are immutable'); END;");}
 function csv(kind){if(!tables[kind])fail('Unknown export.');const rows=db.prepare('SELECT * FROM '+tables[kind]).all();const headers=db.prepare('PRAGMA table_info('+tables[kind]+')').all().map(c=>c.name);const cell=value=>'"'+String(value??'').replace(/^[=+@\-\t\r]/,"'"+'$&').replace(/"/g,'""')+'"';return[headers,...rows.map(row=>headers.map(key=>row[key]))].map(row=>row.map(cell).join(',')).join('\r\n');}
 return{capture,record,report,csv};
}
module.exports={createFinance};
