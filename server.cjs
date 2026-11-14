const http = require("node:http");
const fs = require("node:fs");
const { DatabaseSync } = require("node:sqlite");
const {
  randomBytes,
  scryptSync,
  timingSafeEqual,
} = require("node:crypto");
const path = require("node:path");

const appBootVersion = randomBytes(8).toString('hex');
const PORT = Number(process.env.PORT || 3000);
const CURRENCY = process.env.CURRENCY || "KES";
const DELIVERY_FEE = 350;

const db = new DatabaseSync(
  process.env.DATABASE_PATH || path.join(__dirname, "subanese.sqlite")
);

const uid = () => randomBytes(18).toString("hex");
const hash = (password, salt) =>
  scryptSync(password, salt, 64);

db.exec(`
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY,
    name TEXT,
    category TEXT,
    price INTEGER,
    stock INTEGER,
    allergens TEXT,
    icon TEXT
  );

  CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    token TEXT,
    name TEXT,
    email TEXT,
    phone TEXT,
    method TEXT,
    address TEXT,
    date TEXT,
    items TEXT,
    total INTEGER,
    status TEXT,
    created TEXT
  );

  CREATE TABLE IF NOT EXISTS cakes (
    id TEXT PRIMARY KEY,
    name TEXT,
    email TEXT,
    details TEXT,
    status TEXT,
    created TEXT
  );

  CREATE TABLE IF NOT EXISTS admin (
    salt TEXT,
    password TEXT
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    expires INTEGER
  );
`);

db.exec(`CREATE TABLE IF NOT EXISTS customers (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, salt TEXT NOT NULL, password TEXT NOT NULL, created TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS customer_sessions (token TEXT PRIMARY KEY, customer_id TEXT NOT NULL, expires INTEGER NOT NULL);`);
if (!db.prepare("PRAGMA table_info(customers)").all().some(column => column.name === 'id_number')) db.exec("ALTER TABLE customers ADD COLUMN id_number TEXT NOT NULL DEFAULT ''");
if (!db.prepare("PRAGMA table_info(orders)").all().some(column => column.name === 'customer_id')) db.exec("ALTER TABLE orders ADD COLUMN customer_id TEXT");
db.exec("CREATE INDEX IF NOT EXISTS orders_customer_id ON orders(customer_id)");
if (!db.prepare('PRAGMA table_info(customers)').all().some(column => column.name === 'profile_image')) db.exec("ALTER TABLE customers ADD COLUMN profile_image TEXT NOT NULL DEFAULT ''");
if (!db.prepare('PRAGMA table_info(admin)').all().some(column => column.name === 'display_name')) db.exec("ALTER TABLE admin ADD COLUMN display_name TEXT NOT NULL DEFAULT ''");
for (const [column, fallback] of [['phone', ''], ['preferred_contact', 'email']]) {
  if (!db.prepare('PRAGMA table_info(customers)').all().some(item => item.name === column)) db.exec("ALTER TABLE customers ADD COLUMN " + column + " TEXT NOT NULL DEFAULT '" + fallback + "'");
}
function signedInCustomer(request) {
  const token = /(?:^|;\s*)customer_sid=([^;]+)/.exec(request.headers.cookie || '')?.[1];
  return token ? db.prepare("SELECT c.id, c.name, c.email, c.id_number, c.profile_image, c.phone, c.preferred_contact FROM customers c JOIN customer_sessions s ON s.customer_id = c.id WHERE s.token = ? AND s.expires > ?").get(token, Date.now()) : undefined;
}

// Keep existing orders while adding delivery pin coordinates.
const orderColumns = db.prepare("PRAGMA table_info(orders)").all().map(column => column.name);
for (const column of ["delivery_lat", "delivery_lng"]) {
  if (!orderColumns.includes(column)) db.exec("ALTER TABLE orders ADD COLUMN " + column + " REAL");
}
const productColumns = db.prepare("PRAGMA table_info(products)").all().map(column => column.name);
for (const column of ["ingredients", "image_url"]) {
  if (!productColumns.includes(column)) db.exec("ALTER TABLE products ADD COLUMN " + column + " TEXT NOT NULL DEFAULT ''");
}
if (!productColumns.includes("active")) db.exec("ALTER TABLE products ADD COLUMN active INTEGER NOT NULL DEFAULT 1");

if (!db.prepare("SELECT 1 FROM products LIMIT 1").get()) {
  const insert = db.prepare(
    "INSERT INTO products (id, name, category, price, stock, allergens, icon) VALUES (?, ?, ?, ?, ?, ?, ?)"
  );

  [
    [
      1,
      "Chocolate cloud cake",
      "Cakes",
      3200,
      12,
      "Wheat, eggs, milk, soy",
      "🍫",
    ],
    [
      2,
      "Strawberry daydream",
      "Cakes",
      3500,
      10,
      "Wheat, eggs, milk",
      "🍰",
    ],
    [
      3,
      "Little celebrations",
      "Cupcakes",
      1200,
      24,
      "Wheat, eggs, milk",
      "🧁",
    ],
    [
      4,
      "Brown butter cookies",
      "Cookies",
      850,
      30,
      "Wheat, eggs, milk, soy",
      "🍪",
    ],
    [
      5,
      "Almond croissants",
      "Pastries",
      650,
      20,
      "Wheat, eggs, milk, almonds",
      "🥐",
    ],
    [
      6,
      "Sunday sourdough",
      "Bread",
      700,
      16,
      "Wheat",
      "🍞",
    ],
  ].forEach((product) => insert.run(...product));
}

// Stable product IDs keep cake flavours compatible with saved bags and orders.
const cakeCatalog = [
  { collection: "Vanilla Cakes", items: [
    ["Vanilla Chocolate", 2200], ["Vanilla Cardamom", 2300],
    ["Vanilla Strawberry", 2400], ["Chocolate Chip", 2400],
    ["Yoghurt Vanilla", 2400], ["Cream and Cookie", 2500]
  ] },
  { collection: "Chocolate Cakes", items: [
    ["Peppermint Chocolate", 2400], ["Double Chocolate", 2500],
    ["Blackforest Cake", 2500], ["Red Velvet Cake", 2800],
    ["Chocolate Orange", 3000]
  ] },
  { collection: "Fresh Fruit Cakes", items: [
    ["Passion Curd", 2600], ["Lemon Blueberry with Poppy Seeds", 2700],
    ["Pinnacolada", 2700], ["Blueberry Cake", 2700],
    ["Orange Curd with Poppy Seeds", 2800], ["Lemon Curd", 3000],
    ["Carrot Cake", 3200]
  ] },
  { collection: "Sweet Tooth", items: [
    ["Fruit Cake", 3200], ["Caramel Spice Cake", 3000],
    ["Fudge Cake", 3200], ["Butterscotch", 3000],
    ["Rainbow & Confetti", 3000]
  ] }
].map((group, groupIndex) => ({
  ...group,
  items: group.items.map(([name, price], index) => ({
    id: 101 + groupIndex * 100 + index, name, price
  }))
}));
const insertCake = db.prepare(
  "INSERT OR IGNORE INTO products (id, name, category, price, stock, allergens, icon) VALUES (?, ?, ?, ?, ?, ?, ?)"
);
for (const group of cakeCatalog) {
  for (const cake of group.items) {
    insertCake.run(cake.id, cake.name, "Cakes", cake.price, 12,
      "Recipe-dependent; ask the bakery about ingredients and allergens", "??");
  }
}

if (process.argv.includes("--reset-admin-password")) {
  const password = randomBytes(18).toString("base64url");
  const salt = uid();
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec("DELETE FROM admin");
    db.prepare("INSERT INTO admin (salt, password) VALUES (?, ?)").run(
      salt, hash(password, salt).toString("hex")
    );
    db.exec("DELETE FROM sessions");
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  db.close();
  console.log("Administrator password reset. Existing admin sessions signed out.");
  console.log("New administrator password: " + password);
  console.log("Save this password securely; it cannot be recovered from the database.");
  process.exit(0);
}

if (!db.prepare("SELECT 1 FROM admin").get()) {
  const password = process.env.ADMIN_PASSWORD || uid();

  if (password.length < 12) {
    throw Error(
      "ADMIN_PASSWORD must contain at least 12 characters."
    );
  }

  const salt = uid();

  db.prepare("INSERT INTO admin (salt, password) VALUES (?, ?)").run(
    salt,
    hash(password, salt).toString("hex")
  );

  if (!process.env.ADMIN_PASSWORD) {
    console.log(
      "\nSave this initial administrator password:\n" +
        password +
        "\n"
    );
  }
}

const { createEmailQueue } = require("./order-email.cjs");
const emailQueue = createEmailQueue(db, {env: process.env});

function queueOrderEmail(order) {
  const items = typeof order.items === "string" ? JSON.parse(order.items) : order.items;
  const messages = {
    confirmed: "We have received and confirmed your order.",
    preparing: "Your order is now being prepared.",
    ready: "Your order is ready for pickup.",
    "out for delivery": "Your order is out for delivery.",
    completed: "Your order has been marked completed. Thank you for shopping with us!",
    cancelled: "Your order has been cancelled. Contact the bakery with any questions."
  };
  const lines = items.map(item => item.name + " x " + item.quantity +
    (item.excluded?.length ? "\nRequested without: " + item.excluded.join(", ") : "") +
    (item.notes ? "\nDietary notes: " + item.notes : "")).join("\n");
  let tracking = "";
  if (process.env.PUBLIC_SITE_URL) {
    const base = new URL(process.env.PUBLIC_SITE_URL);
    if (!["http:", "https:"].includes(base.protocol)) throw Error("PUBLIC_SITE_URL must be an HTTP or HTTPS URL.");
    tracking = "\nTrack your order: " + base.origin + "/#/order/" + encodeURIComponent(order.id);
  }
  emailQueue.enqueue({
    eventKey: "order/" + order.id + "/" + order.status,
    reference: order.id, recipient: order.email,
    subject: "Order " + order.id + ": " + order.status,
    body: "Hello " + order.name + ",\n\n" + messages[order.status] +
      "\n\nOrder: " + order.id + "\nStatus: " + order.status +
      "\nDate: " + order.date + "\nMethod: " + order.method +
      (order.address ? "\nDelivery directions: " + order.address : "") +
      "\n\n" + lines + "\n\nTotal: " + CURRENCY + " " + order.total +
      "\nIngredient changes require bakery confirmation." + tracking +
      "\n\npastries by subanesse"
  });
}

function queueCakeEmail(cake) {
  emailQueue.enqueue({
    eventKey: "cake/" + cake.id + "/" + cake.status + "/" + uid(),
    reference: cake.id, recipient: cake.email,
    subject: "Cake request " + cake.id + ": " + cake.status,
    body: "Hello " + cake.name + ",\n\nYour custom cake request " + cake.id +
      " has been updated.\nStatus: " + cake.status +
      "\n\nContact the bakery to confirm the design, ingredients, availability and final price." +
      "\n\npastries by subanesse"
  });
}

function fail(message, status = 400) {
  throw Object.assign(Error(message), { status });
}

function text(value, name, max = 200) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > max
  ) {
    fail("Enter a valid " + name + ".");
  }

  return value.trim();
}

function email(value) {
  value = text(value, "email", 254);

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
    fail("Enter a valid email address.");
  }

  return value;
}

function integer(value, min, max) {
  if (
    !Number.isSafeInteger(value) ||
    value < min ||
    value > max
  ) {
    fail("Number is outside the allowed range.");
  }

  return value;
}

function validDate(value) {
  const date = text(value, "date", 10);
  const timestamp = Date.parse(date + "T00:00:00Z");

  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    !Number.isFinite(timestamp) ||
    new Date(timestamp).toISOString().slice(0, 10) !== date ||
    timestamp < Date.now() + 48 * 3600000
  ) {
    fail("Choose a valid date at least 48 hours away.");
  }

  return date;
}

async function readBody(request) {
  let data = "";

  for await (const chunk of request) {
    data += chunk;

    if (Buffer.byteLength(data) > 15000000) {
      fail("Request too large.", 413);
    }
  }

  try {
    return JSON.parse(data || "{}");
  } catch {
    fail("Invalid JSON.");
  }
}

function requireAdmin(request) {
  const token = /\bsid=([^;]+)/.exec(
    request.headers.cookie || ""
  )?.[1];

  const session =
    token &&
    db
      .prepare(
        "SELECT 1 FROM sessions WHERE token = ? AND expires > ?"
      )
      .get(token, Date.now());

  if (!session) {
    fail("Sign in as administrator.", 401);
  }
}

const finance = require('./finance.cjs').createFinance(db, {currency: CURRENCY, deliveryFee: DELIVERY_FEE});

const loginAttempts = new Map();

const server = http.createServer(async (request, response) => {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Cache-Control", "no-store");

  function send(data, status = 200, headers = {}) {
    response.writeHead(status, {
      "Content-Type": "application/json",
      ...headers,
    });

    response.end(JSON.stringify(data));
  }

  try {
    const url = new URL(
      request.url,
      "http://localhost:" + PORT
    );

    const pathname = url.pathname;

    if (request.method === 'GET' && pathname === '/api/app-version') {
      const files = ['storefront.css','dashboard-ui.js','Logo/LOGO.jpeg','public/assets/storefront.js','public/assets/tailwind.css'];
      const assets = files.map(file => {
        try { const stat = fs.statSync(path.join(__dirname,file)); return file + ':' + stat.mtimeMs + ':' + stat.size; }
        catch { return file + ':missing'; }
      }).join('|');
      return send({version: appBootVersion + '|' + assets, liveReload: process.env.NODE_ENV !== 'production'});
    }


    const frontendAssets = {
      '/assets/storefront.js': ['storefront.js', 'text/javascript; charset=utf-8'],
      '/assets/tailwind.css': ['tailwind.css', 'text/css; charset=utf-8'],
    };
    if (["GET", "HEAD"].includes(request.method) && frontendAssets[pathname]) {
      const [filename, type] = frontendAssets[pathname];
      const file = path.join(__dirname, 'public', 'assets', filename);
      if (!fs.existsSync(file)) fail('Frontend assets unavailable. Run npm run build.', 404);
      const asset = fs.readFileSync(file);
      response.writeHead(200, {'Content-Type': type, 'Content-Length': asset.length, 'Cache-Control': 'no-cache'});
      return response.end(request.method === 'HEAD' ? undefined : asset);
    }

    if (["GET", "HEAD"].includes(request.method) && pathname === "/brand/logo.jpeg") {
      const file = path.join(__dirname, "Logo", "LOGO.jpeg");
      if (!fs.existsSync(file)) fail("Logo unavailable.", 404);
      response.writeHead(200, {"Content-Type": "image/jpeg", "Content-Length": fs.statSync(file).size, "Cache-Control": "public, max-age=86400"});
      if (request.method === "HEAD") return response.end();
      const stream = fs.createReadStream(file);
      stream.on("error", () => response.destroy());
      response.on("close", () => stream.destroy());
      return stream.pipe(response);
    }

    if (["GET", "HEAD"].includes(request.method) && pathname === "/dashboard-ui.js") {
      const script=fs.readFileSync(path.join(__dirname,'dashboard-ui.js'));
      response.writeHead(200,{'Content-Type':'text/javascript; charset=utf-8','Content-Length':script.length});return response.end(request.method==='HEAD'?undefined:script);
    }
    if (["GET", "HEAD"].includes(request.method) && pathname === "/storefront.css") {
      const stylesheet = fs.readFileSync(path.join(__dirname, "storefront.css"));
      response.writeHead(200, {"Content-Type": "text/css; charset=utf-8", "Content-Length": stylesheet.length});
      return response.end(request.method === "HEAD" ? undefined : stylesheet);
    }

    const heroFiles = {"/media/outdoor-celebration.mp4": "video/mp4", "/media/outdoor-celebration.jpg": "image/jpeg", "/media/admin-event.mp4": "video/mp4", "/media/admin-event-4k.mp4": "video/mp4", "/media/admin-event.jpg": "image/jpeg"};
    if (["GET", "HEAD"].includes(request.method) && heroFiles[pathname]) {
      const file = path.join(__dirname, "media", path.basename(pathname));
      if (!fs.existsSync(file)) fail("Media unavailable.", 404);
      const size = fs.statSync(file).size;
      const headers = {"Content-Type": heroFiles[pathname], "Accept-Ranges": "bytes", "Cache-Control": "public, max-age=86400"};
      let start = 0, end = size - 1, status = 200;
      if (request.headers.range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range);
        if (!match || (!match[1] && !match[2])) { response.writeHead(416, {"Content-Range": "bytes */" + size}); return response.end(); }
        start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
        end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) { response.writeHead(416, {"Content-Range": "bytes */" + size}); return response.end(); }
        status = 206; headers["Content-Range"] = "bytes " + start + "-" + end + "/" + size;
      }
      headers["Content-Length"] = end - start + 1;
      response.writeHead(status, headers);
      if (request.method === "HEAD") return response.end();
      const stream = fs.createReadStream(file, {start, end});
      stream.on("error", () => response.destroy());
      response.on("close", () => stream.destroy());
      return stream.pipe(response);
    }

    if (request.method === "GET" && pathname === "/") {
      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
      });

      return response.end(HTML);
    }

    if (
      !["GET", "POST", "PATCH", "DELETE"].includes(request.method)
    ) {
      fail("Method not allowed.", 405);
    }

    if (request.method !== "GET") {
      const allowedOrigins = [
        "http://localhost:" + PORT,
        "http://127.0.0.1:" + PORT,
      ];

      const origin = request.headers.origin;

      if (origin && !allowedOrigins.includes(origin)) {
        fail("Origin not allowed.", 403);
      }

      if (
        !request.headers["content-type"]?.startsWith(
          "application/json"
        )
      ) {
        fail("JSON required.", 415);
      }
    }

    // Public product catalog.
    if (
      request.method === "GET" &&
      pathname === "/api/products"
    ) {
      return send({
        currency: CURRENCY,
        deliveryFee: DELIVERY_FEE,
        products: db.prepare("SELECT * FROM products WHERE active = 1").all(),
      });
    }

    if (pathname.startsWith('/api/customer/')) {
      const action = pathname.split('/').pop();
      const cookie = (token, age) => 'customer_sid=' + token + '; HttpOnly; SameSite=Strict; Path=/; Max-Age=' + age + (request.socket.encrypted ? '; Secure' : '');
      if (request.method === 'POST' && ['register','login'].includes(action)) {
        const key = 'customer:' + request.socket.remoteAddress;
        const old = loginAttempts.get(key);
        const attempt = old && old.until > Date.now() ? old : {count:0,until:Date.now()+600000};
        loginAttempts.set(key,attempt);
        if (++attempt.count > 10) fail('Too many attempts. Try again in ten minutes.',429);
        const body = await readBody(request), address = email(body.email).toLowerCase(), password = text(body.password,'password',128);
        let customer;
        if (action === 'register') {
          const name = text(body.name,'name',100), idNumber = text(body.id_number,'ID number (maximum 8 characters)',8);
          if (password.length < 12) fail('Use at least 12 characters for your password.');
          if (db.prepare('SELECT 1 FROM customers WHERE email = ?').get(address)) fail('Unable to create this account. Try signing in.',409);
          const salt=uid();customer={id:uid(),name,email:address};
          db.prepare('INSERT INTO customers (id,name,email,salt,password,created,id_number) VALUES (?,?,?,?,?,?,?)').run(customer.id,name,address,salt,hash(password,salt).toString('hex'),new Date().toISOString(),idNumber);
        } else {
          const record=db.prepare('SELECT * FROM customers WHERE email = ?').get(address);
          const candidate=hash(password,record?.salt || 'missing-customer');
          if (!record || !timingSafeEqual(candidate,Buffer.from(record.password,'hex'))) fail('Incorrect email or password.',401);
          customer={id:record.id,name:record.name,email:record.email};
        }
        const token=uid();db.prepare('DELETE FROM customer_sessions WHERE expires <= ?').run(Date.now());
        db.prepare('INSERT INTO customer_sessions VALUES (?,?,?)').run(token,customer.id,Date.now()+604800000);
        return send({customer},action==='register'?201:200,{'Set-Cookie':cookie(token,604800)});
      }
      if (request.method === 'POST' && action === 'logout') {
        const token=/(?:^|;\s*)customer_sid=([^;]+)/.exec(request.headers.cookie || '')?.[1];
        if(token) db.prepare('DELETE FROM customer_sessions WHERE token = ?').run(token);
        return send({ok:true},200,{'Set-Cookie':cookie('',0)});
      }
      const customer=signedInCustomer(request);if(!customer) fail('Sign in to view your account.',401);
      if (request.method === 'GET' && action === 'account') return send({customer,cakes:db.prepare('SELECT id,email,status,created,details FROM cakes ORDER BY created DESC').all().filter(cake => { const owner = JSON.parse(cake.details).customer_id; return owner ? owner === customer.id : cake.email.trim().toLowerCase() === customer.email.trim().toLowerCase(); }).map(cake => { const details = JSON.parse(cake.details); return {id:cake.id,status:cake.status,created:cake.created,details:{date:details.date,size:details.size,flavor:details.flavor,notes:details.notes,reference_image:details.reference_image}}; }),orders:db.prepare('SELECT id,created,date,method,total,status,items FROM orders WHERE customer_id = ? ORDER BY created DESC').all(customer.id).map(order=>({...order,items:JSON.parse(order.items)}))});
      if (request.method === 'PATCH' && action === 'profile') {
        const body=await readBody(request);
        if (body.phone !== undefined || body.preferred_contact !== undefined) {
          const phone = typeof body.phone === 'string' ? body.phone.trim() : customer.phone;
          const preferred = body.preferred_contact ?? customer.preferred_contact;
          if (typeof phone !== 'string' || phone.length > 30 || (phone && (!/^[+0-9() .-]+$/.test(phone) || phone.replace(/\D/g,'').length < 7 || phone.replace(/\D/g,'').length > 15))) fail('Enter a valid phone number, including country code.');
          if (!['email','whatsapp','sms'].includes(preferred)) fail('Choose Email, WhatsApp or SMS.');
          if (preferred !== 'email' && !phone) fail('Add a phone number for WhatsApp or SMS.');
          db.prepare('UPDATE customers SET phone = ?, preferred_contact = ? WHERE id = ?').run(phone,preferred,customer.id);
          return send({ok:true});
        }
        if (body.profile_image !== undefined) {
          const image = body.profile_image;
          if (typeof image !== 'string' || image.length > 14000000 || (image && !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(image))) fail('Choose a JPG, PNG or WebP up to 10 MB.');
          db.prepare('UPDATE customers SET profile_image = ? WHERE id = ?').run(image,customer.id);
          return send({ok:true});
        }
        db.prepare('UPDATE customers SET id_number = ? WHERE id = ?').run(text(body.id_number,'ID number (maximum 8 characters)',8),customer.id);return send({ok:true});
      }
      fail('Not found.',404);
    }

    // Administrator sign-in.
    if (
      request.method === "POST" &&
      pathname === "/api/login"
    ) {
      const key = request.socket.remoteAddress;
      const previous = loginAttempts.get(key);

      const attempt =
        previous && previous.until > Date.now()
          ? previous
          : {
              count: 0,
              until: Date.now() + 600000,
            };

      loginAttempts.set(key, attempt);

      if (++attempt.count > 10) {
        fail(
          "Too many attempts. Try again in ten minutes.",
          429
        );
      }

      const body = await readBody(request);
      const password = text(
        body.password,
        "password",
        128
      );

      const administrator = db
        .prepare("SELECT * FROM admin")
        .get();

      const valid = timingSafeEqual(
        hash(password, administrator.salt),
        Buffer.from(administrator.password, "hex")
      );

      if (!valid) {
        fail("Incorrect password.", 401);
      }

      const token = uid();

      db.prepare("INSERT INTO sessions VALUES (?, ?)").run(
        token,
        Date.now() + 8 * 3600000
      );

      return send(
        { ok: true },
        200,
        {
          "Set-Cookie":
            "sid=" +
            token +
            "; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800",
        }
      );
    }

    if (
      request.method === "POST" &&
      pathname === "/api/logout"
    ) {
      const token = /\bsid=([^;]+)/.exec(
        request.headers.cookie || ""
      )?.[1];

      if (token) {
        db.prepare(
          "DELETE FROM sessions WHERE token = ?"
        ).run(token);
      }

      return send(
        { ok: true },
        200,
        {
          "Set-Cookie":
            "sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0",
        }
      );
    }

    // Create an order. Prices always come from the database.
    if (
      request.method === "POST" &&
      pathname === "/api/orders"
    ) {
      const body = await readBody(request);

      const customer = signedInCustomer(request);
      if (!customer) fail("Sign in or create an account before placing an order.", 401);
      if (!customer.id_number) fail("Add your ID number in My account before placing an order.", 403);
      const name = text(body.name, "name", 100);
      const customerEmail = email(body.email);
      const phone = text(body.phone, "phone", 40);
      const date = validDate(body.date);

      if (
        !["pickup", "delivery"].includes(body.method)
      ) {
        fail("Choose pickup or delivery.");
      }

      const address =
        body.method === "delivery"
          ? (body.address === undefined || body.address === ""
              ? "" : text(body.address, "delivery directions", 500))
          : "";
      let deliveryLat = null;
      let deliveryLng = null;
      if (body.method === "delivery") {
        const pin = body.deliveryLocation;
        if (!pin || typeof pin.lat !== "number" || typeof pin.lng !== "number" ||
            !Number.isFinite(pin.lat) || !Number.isFinite(pin.lng) ||
            pin.lat < -90 || pin.lat > 90 || pin.lng < -180 || pin.lng > 180) {
          fail("Choose a valid delivery location on the map.");
        }
        deliveryLat = pin.lat;
        deliveryLng = pin.lng;
      }

      if (
        !Array.isArray(body.items) ||
        !body.items.length ||
        body.items.length > 20
      ) {
        fail("Your bag is empty or too large.");
      }

      db.exec("BEGIN IMMEDIATE");

      try {
        const lines = [];
        const seen = new Set();

        let total =
          body.method === "delivery"
            ? DELIVERY_FEE
            : 0;

        for (const item of body.items) {
          const product = db
            .prepare(
            "SELECT * FROM products WHERE id = ? AND active = 1"
            )
            .get(integer(item.id, 1, 100000));

          const quantity = integer(
            item.quantity,
            1,
            50
          );

          if (
            !product ||
            seen.has(product.id) ||
            product.stock < quantity
          ) {
            fail(
              "An item is sold out or has insufficient stock."
            );
          }

          seen.add(product.id);
          const excluded = item.excluded ?? [];
          if (!Array.isArray(excluded) || excluded.length > 6 ||
              excluded.some(value => !["Cheese / cream cheese", "Milk", "Cream", "Butter", "Yoghurt", "Nuts"].includes(value)) ||
              new Set(excluded).size !== excluded.length) {
            fail("Choose valid ingredient preferences.");
          }
          const notes = item.notes === undefined ? "" : item.notes;
          if (typeof notes !== "string" || notes.length > 500) fail("Keep dietary notes under 500 characters.");
          total += product.price * quantity;

          lines.push({
            id: product.id,
            name: product.name,
            price: product.price,
            quantity,
            excluded,
            notes: notes.trim(),
          });

          db.prepare(
            "UPDATE products SET stock = stock - ? WHERE id = ?"
          ).run(quantity, product.id);
        }

        const id =
          "SUB-" + uid().slice(0, 10).toUpperCase();

        const token = uid();

        db.prepare(`
          INSERT INTO orders
          (id, token, name, email, phone, method, address, date, items, total, status, created, delivery_lat, delivery_lng)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          id,
          token,
          name,
          customerEmail,
          phone,
          body.method,
          address,
          date,
          JSON.stringify(lines),
          total,
          "confirmed",
          new Date().toISOString(),
          deliveryLat,
          deliveryLng
        );

        db.prepare("UPDATE orders SET customer_id = ? WHERE id = ?").run(customer.id, id);
        finance.capture(id);
        queueOrderEmail(db.prepare("SELECT * FROM orders WHERE id = ?").get(id));
        db.exec("COMMIT");
        void emailQueue.flush();

        return send(
          {
            id,
            token,
            total,
            status: "confirmed",
          },
          201
        );
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    }

    // Private guest order tracking.
    if (
      request.method === "GET" &&
      pathname.startsWith("/api/orders/")
    ) {
      const customer = signedInCustomer(request);
      if (!customer) fail("Sign in to view your orders.", 401);
      const order = db
        .prepare(
          "SELECT * FROM orders WHERE id = ? AND customer_id = ?"
        )
        .get(
          pathname.split("/").pop(),
          customer.id
        );

      if (!order) {
        fail("Order not found.", 404);
      }

      return send({
        id: order.id,
        items: JSON.parse(order.items),
        total: order.total,
        status: order.status,
        date: order.date,
        method: order.method,
        address: order.address,
        deliveryLocation: order.delivery_lat !== null && order.delivery_lng !== null
          ? { lat: order.delivery_lat, lng: order.delivery_lng } : null,
      });
    }

    // Custom cake request.
    if (
      request.method === "POST" &&
      pathname === "/api/cakes"
    ) {
      const body = await readBody(request);

      const customer = signedInCustomer(request);
      if (!customer) fail('Sign in to submit and track your custom cake.', 401);
      const name = customer.name;
      const customerEmail = customer.email;
      const date = validDate(body.date);
      const size = text(body.size, "size", 30);
      const flavor = text(body.flavor, "flavour", 30);
      const notes = text(
        body.notes,
        "cake idea",
        2000
      );

      if (
        !["0.5 kg", "1 kg", "1.5 kg", "2 kg", "3 kg", "4 kg", "5 kg"].includes(size) ||
        !cakeCatalog.flatMap(group => group.items.map(item => item.name)).includes(flavor)
      ) {
        fail("Choose a supported cake option.");
      }

      const referenceImage = body.reference_image || '';
      if (typeof referenceImage !== 'string' || referenceImage.length > 14000000) fail('Choose an image up to 10 MB.');
      if (referenceImage && !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(referenceImage)) {
        let imageURL;
        try { imageURL = new URL(referenceImage); } catch { fail('Enter a valid HTTPS image URL.'); }
        if (imageURL.protocol !== 'https:' || imageURL.username || imageURL.password || referenceImage.length > 2048) fail('Enter a valid HTTPS image URL.');
      }

      const id =
        "CAKE-" + uid().slice(0, 10).toUpperCase();

      db.exec("BEGIN IMMEDIATE");
      try {
      db.prepare(
        "INSERT INTO cakes VALUES (?, ?, ?, ?, ?, ?)"
      ).run(
        id,
        name,
        customerEmail,
        JSON.stringify({
          date,
          size,
          flavor,
          notes,
          reference_image: referenceImage,
          customer_id: customer.id,
          phone: customer.phone,
          preferred_contact: customer.preferred_contact,
        }),
        "new",
        new Date().toISOString()
      );

        queueCakeEmail({id, name, email: customerEmail, status: "new"});
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      void emailQueue.flush();

      return send(
        {
          id,
          status: "new",
        },
        201
      );
    }

    // Protected administrator endpoints.
    if (pathname.startsWith("/api/admin")) {
      requireAdmin(request);
      if (pathname === '/api/admin/profile' && request.method === 'PATCH') {
        const body = await readBody(request);
        const name = text(body.name, 'admin name', 100);
        db.prepare('UPDATE admin SET display_name = ?').run(name);
        return send({ok:true});
      }
      if (pathname === '/api/admin/finance' && request.method === 'GET') return send(finance.report());
      if (pathname === '/api/admin/finance/export' && request.method === 'GET') {
        const csv = finance.csv(url.searchParams.get('type'));
        response.writeHead(200, {'Content-Type':'text/csv; charset=utf-8', 'Content-Disposition':'attachment; filename="subanese-finance.csv"'});
        return response.end(csv);
      }
      if (pathname.startsWith('/api/admin/finance/') && request.method === 'POST') return send(finance.record(pathname.split('/').pop(), await readBody(request)), 201);


      if (request.method === "GET" && pathname === "/api/admin/session") {
        return send({authenticated: true});
      }

      if (
        request.method === "GET" &&
        pathname === "/api/admin"
      ) {
        const orders = db
          .prepare(
            url.searchParams.get('order') ? 'SELECT * FROM orders WHERE id = ?' : 'SELECT * FROM orders ORDER BY created DESC LIMIT 200'
          )
          .all(...(url.searchParams.get('order') ? [url.searchParams.get('order')] : []))
          .map(({ token, ...order }) => ({
            ...order,
            items: JSON.parse(order.items),
          }));

        const cakes = db
          .prepare(
            "SELECT * FROM cakes ORDER BY created DESC LIMIT 200"
          )
          .all()
          .map((cake) => ({
            ...cake,
            details: JSON.parse(cake.details),
          }));

        return send({
          orders: orders.map(order => ({...order, notification: emailQueue.latest(order.id)})),
          cakes,
          profile: {username: process.env.ADMIN_USERNAME || "Administrator", name: db.prepare("SELECT display_name FROM admin LIMIT 1").get()?.display_name || process.env.ADMIN_NAME || process.env.ADMIN_USERNAME || "Administrator"},
          finance: finance.report(),
          marketingHolidays: (process.env.MARKETING_HOLIDAYS || "").split(",").map(date => date.trim()).filter(date => /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(date)) && new Date(date).toISOString().slice(0,10) === date),
          analytics: db.prepare("SELECT id, name, created, date, total, status, method, items FROM orders ORDER BY created DESC").all().map(order => ({...order, items: JSON.parse(order.items)})),
          emailConfigured: emailQueue.configured
        });
      }

      if (
        request.method === "PATCH" &&
        pathname.startsWith("/api/admin/orders/")
      ) {
        const id = pathname.split("/").pop();
        const body = await readBody(request);

        const order = db
          .prepare(
            "SELECT * FROM orders WHERE id = ?"
          )
          .get(id);

        if (!order) {
          fail("Order not found.", 404);
        }

        const transitions = {
          confirmed: ["preparing", "cancelled"],
          preparing: [
            order.method === "pickup"
              ? "ready"
              : "out for delivery",
          ],
          ready: ["completed"],
          "out for delivery": ["completed"],
        };

        if (
          !transitions[order.status]?.includes(
            body.status
          )
        ) {
          fail("Invalid status transition.");
        }

        db.exec("BEGIN IMMEDIATE");

        try {
          if (body.status === "cancelled") {
            for (const item of JSON.parse(order.items)) {
              db.prepare(
                "UPDATE products SET stock = stock + ? WHERE id = ?"
              ).run(item.quantity, item.id);
            }
          }

          db.prepare(
            "UPDATE orders SET status = ? WHERE id = ?"
          ).run(body.status, id);

          queueOrderEmail({...order, status: body.status});
          db.exec("COMMIT");
          void emailQueue.flush();
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }

        return send({ ok: true });
      }

      if (request.method === "DELETE" && pathname.startsWith("/api/admin/products/")) {
        const id = integer(Number(pathname.split("/").pop()), 1, 100000);
        const result = db.prepare("UPDATE products SET active = 0 WHERE id = ? AND active = 1").run(id);
        if (!result.changes) fail("Product not found.", 404);
        return send({ok: true});
      }

      if (
        (request.method === "PATCH" && pathname.startsWith("/api/admin/products/")) ||
        (request.method === "POST" && pathname === "/api/admin/products")
      ) {
        const creating = request.method === "POST";
        const id = creating ? Math.max(1000, db.prepare("SELECT COALESCE(MAX(id), 0) + 1 AS id FROM products").get().id) : Number(
          pathname.split("/").pop()
        );

        const body = await readBody(request);

        const currentProduct = creating ? {ingredients: "", image_url: "", allergens: ""} : db
            .prepare(
              "SELECT * FROM products WHERE id = ? AND active = 1"
            )
            .get(id);
        if (!currentProduct) {
          fail("Product not found.", 404);
        }

        const ingredients = body.ingredients ?? currentProduct.ingredients;
        const image = body.image_url ?? currentProduct.image_url;
        const allergens = body.allergens ?? currentProduct.allergens;
        if (typeof ingredients !== "string" || ingredients.length > 5000) fail("Keep ingredients under 5,000 characters.");
        if (typeof allergens !== "string" || allergens.length > 1000) fail("Keep allergen information under 1,000 characters.");
        if (typeof image !== "string" || image.length > 14000000) fail("Choose an image up to 10 MB.");
        if (image && !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(image)) {
          let imageURL;
          try { imageURL = new URL(image); } catch { fail("Enter a valid HTTPS image URL."); }
          if (imageURL.protocol !== "https:" || imageURL.username || imageURL.password || image.length > 2048) fail("Enter a valid HTTPS image URL.");
        }

        if (creating) {
          const name = text(body.name, "item name", 100);
          const category = text(body.category, "category", 60);
          const price = integer(body.price, 1, 1000000);
          const stock = integer(body.stock, 0, 10000);
          if (!ingredients.trim()) fail("Enter the item's ingredients.");
          if (!allergens.trim()) fail("Enter allergen information, or state if none are declared.");
          db.prepare("INSERT INTO products (id, name, category, price, stock, allergens, icon, ingredients, image_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
            .run(id, name, category, price, stock, allergens.trim(), "", ingredients.trim(), image);
          return send({id}, 201);
        }

        db.prepare(`
          UPDATE products
          SET price = ?, stock = ?, ingredients = ?, image_url = ?, allergens = ?, name = ?, category = ?
          WHERE id = ?
        `).run(
          integer(body.price, 1, 1000000),
          integer(body.stock, 0, 10000),
          ingredients.trim(),
          image,
          allergens.trim(),
          body.name === undefined ? currentProduct.name : text(body.name, "item name", 100),
          body.category === undefined ? currentProduct.category : text(body.category, "category", 60),
          id
        );

        return send({ ok: true });
      }

      if (
        request.method === "PATCH" &&
        pathname.startsWith("/api/admin/cakes/")
      ) {
        const id = pathname.split("/").pop();
        const body = await readBody(request);

        if (
          ![
            "new",
            "reviewed",
            "contacted",
            "confirmed",
            "preparing",
            "ready",
            "completed",
            "cancelled",
            "declined",
          ].includes(body.status)
        ) {
          fail("Invalid status.");
        }

        const cake = db.prepare("SELECT * FROM cakes WHERE id = ?").get(id);
        if (!cake) fail("Cake request not found.", 404);
        if (body.internal_notes !== undefined) {
          if (typeof body.internal_notes !== 'string' || body.internal_notes.length > 4000) fail('Keep internal notes under 4,000 characters.');
          const details = JSON.parse(cake.details);
          details.internal_notes = body.internal_notes.trim();
          db.prepare('UPDATE cakes SET details = ? WHERE id = ?').run(JSON.stringify(details), id);
        }
        if (cake.status !== body.status) {
          db.exec("BEGIN IMMEDIATE");
          try {
            db.prepare("UPDATE cakes SET status = ? WHERE id = ?").run(body.status, id);
            queueCakeEmail({...cake, status: body.status});
            db.exec("COMMIT");
          } catch (error) {
            db.exec("ROLLBACK");
            throw error;
          }
          void emailQueue.flush();
        }

        return send({ ok: true });
      }
    }

    fail("Page not found.", 404);
  } catch (error) {
    if (!error.status) {
      console.error(error);
    }

    send(
      {
        error: error.status
          ? error.message
          : "Server error.",
      },
      error.status || 500
    );
  }
});

const HTML = String.raw`
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Subanese | We bake, you take</title>
<meta name="theme-color" content="#ed9223">
<link rel="icon" type="image/jpeg" href="/brand/logo.jpeg">
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>

<script id="theme-init">
(() => {
  let theme;
  try { theme = localStorage.getItem('subanese-theme'); } catch {}
  if (!['light', 'dark'].includes(theme)) theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  document.documentElement.dataset.theme = theme;
})();
</script>

<style>
:root {
  --cream: #fffafa;
  --brand-orange: #ed9223;
  --brand-pink: #db72a4;
  --brand-yellow: #f8d849;
  --surface: #fffdfd;
  --muted: #726269;
  --ink: #292326;
  --accent: #a84f12;
  --line: #ead9e0;
  --gutter: clamp(10px, 1vw, 16px);
}

* { box-sizing: border-box; }

body {
  margin: 0;
  background: var(--cream);
  color: var(--ink);
  font: 15px/1.6 Arial, sans-serif;
}

button, input, select, textarea { font: inherit; }
button, a { cursor: pointer; }
a { color: inherit; text-decoration: none; }

button:focus-visible,
a:focus-visible,
input:focus-visible,
select:focus-visible,
textarea:focus-visible {
  outline: 3px solid var(--accent);
  outline-offset: 3px;
}

.site-header {
  position: sticky;
  top: 0;
  z-index: 50;
  background: var(--cream);
  box-shadow: 0 4px 16px #3922150a;
}

.top {
  text-align: center;
  background: var(--ink);
  color: var(--cream);
  font-size: 11px;
  padding: 8px;
}

header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 20px;
  padding: 24px var(--gutter);
  border-bottom: 1px solid var(--line);
}

.brand { font: bold 24px Georgia, serif; }
nav { display: flex; gap: 24px; font-size: 12px; }
.category-nav {
  display: flex;
  gap: 8px;
  padding: 12px var(--gutter);
  overflow-x: auto;
  border-bottom: 1px solid var(--line);
  background: #fff7fb;
  scrollbar-width: thin;
}
.category-nav a {
  flex: 0 0 auto;
  padding: 8px 16px;
  border: 1px solid transparent;
  border-radius: 999px;
  white-space: nowrap;
  font-size: 13px;
}
.category-nav a:hover { background: #f8eaf0; }
.category-nav a[aria-current="page"] { background: var(--ink); color: var(--cream); }

.wrap {
  max-width: none;
  margin: auto;
  padding: 0 var(--gutter);
}

h1, h2, h3 {
  font-family: Georgia, serif;
  font-weight: 400;
  line-height: 1.1;
}

h1 {
  font-size: clamp(48px, 6vw, 82px);
  letter-spacing: -3px;
  margin: 20px 0 25px;
}

h2 { font-size: 38px; margin: 0 0 24px; }
h3 { font-size: 23px; margin: 12px 0; }
p { color: #806d5c; margin: 0 0 16px; }
.eyebrow + h1, .eyebrow + h2 { margin-top: 16px; }

.eyebrow {
  color: var(--accent);
  font-size: 10px;
  letter-spacing: 3px;
  text-transform: uppercase;
}

.hero {
  display: grid;
  grid-template-columns: 1.2fr 1fr;
  gap: clamp(28px, 5vw, 64px);
  align-items: center;
  padding: 65px 0;
}

.hero em { color: var(--accent); }
.hero p { max-width: 370px; }
.hero .btn { margin: 8px 8px 0 0; }

.hero-art {
  background: #e8d9c7;
  border-radius: 50% 50% 4px 4px;
  min-height: 420px;
  display: grid;
  place-content: center;
  text-align: center;
}

.hero-art .cake {
  font-size: 180px;
  line-height: 1.3;
}

.hero-art span { font: 23px Georgia, serif; }

.btn {
  background: var(--accent);
  border: 1px solid var(--accent);
  padding: 13px 23px;
  color: white;
  border-radius: 3px;
  display: inline-block;
  font-size: 12px;
}

.btn:disabled { opacity: .5; cursor: not-allowed; }

.secondary {
  background: transparent;
  color: var(--ink);
  border-color: var(--line);
}

.row {
  display: flex;
  justify-content: space-between;
  gap: 15px;
  align-items: center;
  flex-wrap: wrap;
}

.promise {
  display: flex;
  justify-content: space-between;
  padding: 20px 0;
  border-block: 1px solid var(--line);
  font-size: 11px;
}

.section { padding: clamp(36px, 5vw, 64px) 0; }
.section > .row { margin-bottom: 28px; }
.section > .row h2 { margin-bottom: 0; }

.grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 36px 28px;
}

.art {
  background: #f6e6ed;
  aspect-ratio: 1.2;
  display: grid;
  place-content: center;
  font-size: 100px;
  border-radius: 3px;
}

.art { overflow: hidden; }
.art > img { width: 100%; height: 100%; object-fit: cover; }
.art:has(> img) { display: block; font-size: 0; }
.art > small { font-size: 12px; padding: 20px; }
.photo-caption { display: block; margin-top: 12px; font-size: 11px; color: #806d5c; }
.product:nth-child(2n) .art { background: #edddd8; }
.product:nth-child(3n) .art { background: #e3e5d6; }
.product { min-width: 0; }
.product .art { margin-bottom: 18px; }
.product h3 { margin: 0 0 12px; }
.product p { margin-bottom: 14px; }
.product .row { margin-top: 18px; }
.product p { font-size: 11px; }
.price { font-size: 13px; }

.toolbar {
  display: flex;
  gap: 16px;
  flex-wrap: wrap;
  margin: 28px 0 36px;
}

.panel {
  border: 1px solid var(--line);
  padding: clamp(20px, 3vw, 32px);
  background: #fff7fb;
  margin: 20px 0;
}
.panel > :last-child { margin-bottom: 0; }
.two > .panel { margin: 0; }
.panel > .fields { margin-bottom: 24px; }
.panel > label { margin-bottom: 20px; }

.two,
.fields {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 32px;
  align-items: start;
}

.fields { gap: 20px; }
.wide { grid-column: 1 / -1; }
label { display: block; font-size: 12px; }

input, select, textarea {
  display: block;
  background: #fffcf7;
  border: 1px solid var(--line);
  width: 100%;
  padding: 11px;
  margin-top: 5px;
  border-radius: 2px;
}

textarea { min-height: 110px; }

dialog {
  margin: auto;
  max-width: calc(100vw - 25px);
  width: 500px;
  border: 1px solid var(--line);
  background: var(--cream);
  padding: 25px;
  color: var(--ink);
  max-height: 90vh;
  overflow: auto;
  border-radius: 14px;
  box-shadow: 0 24px 80px #28150940;
}

.cake-preview { width: 100%; border: 0; padding: 0; color: inherit; font: inherit; cursor: pointer; }
.inline-ingredients { padding: 16px; margin: 8px 0 16px; background: #fff7fb; border: 1px solid var(--line); border-radius: 8px; cursor: default; }
.inline-ingredients ul { padding-left: 20px; margin: 0 0 12px; }
.inline-ingredients li { margin: 8px 0; font-size: 12px; }
.inline-ingredients p:last-child { margin-bottom: 0; }
.product-title { background: none; border: 0; padding: 0; color: inherit; font: inherit; text-align: left; }
.product-title:hover, .product-title:focus-visible { color: var(--accent); text-decoration: underline; text-underline-offset: 5px; }
.cake-preview { cursor: default; }
 .inline-photo-preview { position: relative; margin-bottom: 18px; }
.inline-photo-preview img { display: block; width: 100%; height: auto; max-height: 480px; object-fit: contain; border-radius: 8px; }
.inline-photo-close { position: absolute; top: 8px; right: 8px; width: 36px; height: 36px; padding: 0; border: 1px solid var(--line); border-radius: 50%; background: #fff7fbed; color: var(--ink); font-size: 26px; line-height: 1; }
.cake-preview[hidden] { display: none; }

.cake-options { background: none; border: 0; padding: 8px 0; color: var(--accent); text-decoration: underline; }
.cake-detail-photo { width: 100%; max-height: 240px; object-fit: cover; border-radius: 8px; margin: 20px 0 8px; }
#cake-content h2 { margin-bottom: 20px; }
#cake-content fieldset { border: 1px solid var(--line); padding: 16px; margin: 20px 0; }
.ingredient-option { display: flex; gap: 12px; align-items: center; padding: 10px 0; font-size: 14px; }
.ingredient-option input { width: 20px; height: 20px; margin: 0; accent-color: var(--accent); }
#cake-content .btn { margin-top: 16px; }
#close-cake {
  display: grid;
  place-items: center;
  position: sticky;
  top: 0;
  z-index: 1;
  margin: 0 0 12px auto;
  width: 44px;
  height: 44px;
  padding: 0;
  line-height: 1;
  border: 1px solid var(--line);
  border-radius: 50%;
  background: var(--cream);
  color: var(--ink);
}
#close-cake:hover { background: #f6e6ed; }
body:has(#cake-details[open]) { overflow: hidden; }
dialog::backdrop { background: #28150977; }
body:has(#cart[open]) { overflow: hidden; }
dialog h2 { font-size: 30px; margin: 0; }
dialog > .row { margin-bottom: 20px; }

#bag {
  position: fixed;
  right: max(20px, env(safe-area-inset-right));
  bottom: max(20px, env(safe-area-inset-bottom));
  z-index: 100;
  display: flex;
  align-items: center;
  gap: 10px;
  border-radius: 999px;
  background: var(--ink);
  color: var(--cream);
  box-shadow: 0 6px 24px #28150933;
}

#bag[hidden] { display: none; }

#count {
  display: inline-grid;
  place-items: center;
  min-width: 26px;
  height: 26px;
  padding: 0 6px;
  border-radius: 999px;
  background: var(--cream);
  color: var(--ink);
}

.close {
  border: 0;
  background: none;
  font-size: 28px;
}

.line {
  padding: 15px 0;
  border-bottom: 1px solid var(--line);
}

.qty {
  display: inline-flex;
  gap: 12px;
  align-items: center;
}

.qty button {
  border: 1px solid var(--line);
  background: none;
  width: 28px;
}

.notice {
  color: var(--accent);
  font-size: 12px;
  padding: 12px 0;
  border-block: 1px solid var(--line);
}

.error { color: #a12c24; }
.small { font-size: 11px; }

.badge {
  font-size: 11px;
  background: #e4e8d8;
  padding: 4px 9px;
  border-radius: 20px;
}

.search { max-width: 320px; margin: 0; }

footer {
  background: #f8eaf0;
  padding: 40px var(--gutter) 100px;
  margin-top: 24px;
  font-size: 12px;
}

#message {
  position: fixed;
  bottom: 92px;
  left: 50%;
  transform: translateX(-50%);
  background: var(--ink);
  color: white;
  padding: 12px 20px;
  z-index: 10;
  max-width: 90%;
  display: none;
}

#delivery-map { height: 320px; width: 100%; margin: 20px 0 12px; border: 1px solid var(--line); border-radius: 8px; z-index: 0; }
#delivery-picker .fields { margin: 16px 0; }
#delivery-picker details { margin: 16px 0; }
#open-delivery-map { display: inline-flex; align-items: center; gap: 10px; }
#delivery-pin-summary { margin: 12px 0 0; }
#delivery-picker .leaflet-control a { cursor: pointer; }
.admin-product-photo { width: 100%; height: 180px; object-fit: cover; border-radius: 8px; margin-bottom: 20px; }
.admin-view .site-header, .admin-view footer, .admin-view #bag { display: none; }
.admin-view .wrap { max-width: none; }
.admin-layout { display: grid; grid-template-columns: 220px minmax(0, 1fr); gap: 40px; align-items: start; }
.admin-sidebar { position: sticky; top: 24px; padding: 32px 20px; margin-top: 24px; background: #fff7fb; border: 1px solid var(--line); border-radius: 12px; }
.admin-sidebar .brand { display: block; font-size: 22px; margin-bottom: 16px; }
.admin-sidebar nav { display: flex; flex-direction: column; gap: 8px; margin: 28px 0; }
.admin-sidebar nav a { padding: 12px 16px; border-radius: 8px; font-size: 14px; }
.admin-sidebar nav a:hover { background: #f8eaf0; }
.admin-sidebar nav a[aria-current="page"] { background: var(--ink); color: var(--cream); }
.admin-store-link { font-size: 12px; color: var(--accent); }
.admin-content { min-width: 0; }
.admin-item-grid { grid-template-columns: repeat(auto-fit, minmax(min(100%, 280px), 1fr)); margin: 24px 0 40px; }
.admin-item-grid > .panel { margin: 0; }
.admin-item-grid summary { cursor: pointer; color: var(--accent); padding: 12px 0; }
.admin-item-grid form > label { margin-bottom: 16px; }
.admin-content h1 { font-size: clamp(32px, 4vw, 52px); letter-spacing: -1px; }
.admin-stats { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; margin-bottom: 24px; }
.admin-stats .panel { margin: 0; }
.admin-stats h2 { margin: 0; }
@media (max-width: 850px) {
  .admin-layout { grid-template-columns: 170px minmax(0, 1fr); gap: 20px; }
  .admin-stats { grid-template-columns: 1fr; }
}
@media (max-width: 600px) {
  .admin-layout { grid-template-columns: 1fr; gap: 0; }
  .admin-sidebar { position: static; padding: 20px; }
  .admin-sidebar nav { flex-direction: row; flex-wrap: wrap; gap: 4px; margin: 16px 0; }
  .admin-sidebar nav a { padding: 10px 12px; }
}
.table { overflow: auto; }
.order-progress { display: flex; flex-wrap: wrap; gap: 20px; list-style: none; padding: 0; margin: 28px 0; }
.order-progress li { display: flex; align-items: center; gap: 8px; font-size: 12px; color: #806d5c; }
.order-progress li span { display: grid; place-items: center; width: 30px; height: 30px; border: 1px solid var(--line); border-radius: 50%; }
.order-progress .reached span { background: var(--accent); color: white; border-color: var(--accent); }
.order-progress [aria-current="step"] { font-weight: bold; color: var(--ink); }

table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
  text-align: left;
}

td, th {
  padding: 12px;
  border-bottom: 1px solid var(--line);
  min-width: 110px;
  vertical-align: top;
}

td button { margin: 4px; }

.product-pagination { display: flex; align-items: center; justify-content: center; flex-wrap: wrap; gap: 16px; margin-top: 28px; }
/* Storefront density: show more products while keeping cards readable. */
body:not(.admin-view) .grid { grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 24px 18px; }
body:not(.admin-view) .product .art { aspect-ratio: 1.45; margin-bottom: 12px; }
body:not(.admin-view) .product h3 { font-size: 21px; margin-bottom: 8px; }
body:not(.admin-view) .product p { margin-bottom: 10px; }
@media (min-width: 701px) and (max-width: 1000px) {
  body:not(.admin-view) .grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
}
@media (max-width: 700px) {
  body:not(.admin-view) .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 22px 12px; }
}
@media (max-width: 440px) {
  body:not(.admin-view) .grid { grid-template-columns: minmax(0, 1fr); }
}

@media (max-width: 700px) {
  header { flex-wrap: wrap; }
  .brand { font-size: 20px; }
  nav { gap: 16px; }

  .hero {
    grid-template-columns: 1fr;
    gap: 25px;
    padding: 35px 0;
  }

  .hero-art { min-height: 310px; }
  .hero-art .cake { font-size: 130px; }

  .grid {
    grid-template-columns: 1fr 1fr;
    gap: 28px 16px;
  }

  .art { font-size: 75px; }
  .two, .fields { grid-template-columns: 1fr; }
  .wide { grid-column: auto; }
  .promise span:last-child { display: none; }
  .promise { font-size: 10px; }
  h2 { font-size: 30px; }
  h3 { font-size: 20px; }
}

@media (max-width: 440px) {
  .grid { grid-template-columns: 1fr; }
  .toolbar { gap: 12px; }
  .search { max-width: none; }
  .two { gap: 24px; }
  dialog { padding: 20px; }
}

/* Category previews: photos and individual products can be added later. */
.cake-menu-group{margin:32px 0}.cake-menu-group>h3{font-size:26px}.category-card{display:block;border-radius:14px;transition:transform .2s,box-shadow .2s}.category-card:hover{transform:translateY(-3px);box-shadow:0 10px 25px #39221512}.category-art{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;overflow:hidden}.category-art span{font-size:64px}.category-art small{font:12px Arial,sans-serif;color:#65545c}.category-art img{width:100%;height:100%;object-fit:cover}.category-link{font-size:13px;font-weight:bold;color:var(--accent)}.category-intro{margin-bottom:28px}.cake-collections{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.cake-collections>div{padding:18px;border:1px solid var(--line);border-radius:10px;background:var(--cream)}@media(max-width:600px){.cake-collections{grid-template-columns:1fr}}@media(prefers-reduced-motion:reduce){.category-card{transition:none}.category-card:hover{transform:none}}

/* Restored administration layout */
.dashboard-filters { justify-content: flex-start; margin-bottom: 16px; }
.admin-layout { gap: 16px; }
.admin-content { min-width: 0; container-type: inline-size; }
.admin-content.section { padding-top: 20px; }
.admin-content input, .admin-content select, .admin-content textarea { min-width: 0; max-width: 100%; }
.admin-content .row > *, .admin-sidebar { min-width: 0; max-width: 100%; }
.admin-content .table { max-width: 100%; }
.admin-stats { grid-template-columns: repeat(auto-fit, minmax(min(100%, 145px), 1fr)); gap: 10px; margin: 20px 0; }
.admin-stats .kpi-card { padding: 14px; border-radius: 10px; }
.kpi-card p { font-size: 11px; margin: 0; }
.kpi-card strong { display: block; font-size: clamp(18px,1.6vw,24px); margin: 8px 0; overflow-wrap: anywhere; }
.kpi-card small { display: block; font-size: 10px; line-height: 1.5; color: #726269; }
.dashboard-charts { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 20px; margin: 24px 0; }
.dashboard-charts .panel { margin: 0; min-width: 0; border-radius: 12px; }
.dashboard-charts h3 { margin-top: 0; }
.trend-chart { display: block; width: 100%; height: auto; }
.dashboard-bars { padding: 0; list-style: none; }
.dashboard-bars li { margin: 18px 0; }
.dashboard-bars li > div:first-child { display: flex; justify-content: space-between; gap: 12px; font-size: 13px; margin-bottom: 8px; }
.bar-track { height: 9px; background: #f8eaf0; border-radius: 8px; overflow: hidden; }
.bar-track span { display: block; height: 100%; background: var(--accent); border-radius: inherit; }
.admin-toolbar { display: flex; justify-content: flex-end; margin-bottom: 12px; }
.profile-menu { position: relative; }
.profile-menu > summary { display: grid; place-items: center; width: 42px; height: 42px; border: 1px solid var(--line); border-radius: 50%; background: #fff7fb; cursor: pointer; list-style: none; }
.profile-menu > summary::-webkit-details-marker { display: none; }
.profile-dropdown { position: absolute; top: 50px; right: 0; width: min(250px,calc(100vw - 32px)); padding: 16px; background: #fff7fb; border: 1px solid var(--line); border-radius: 12px; box-shadow: 0 12px 30px #39221520; z-index: 60; overflow-wrap: anywhere; }
.profile-dropdown button { display: block; width: 100%; padding: 12px 8px; text-align: left; border: 0; background: transparent; color: var(--ink); cursor: pointer; }
.profile-dropdown button:hover { background: #f8eaf0; }
.profile-menu summary:focus-visible, .profile-dropdown button:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
@container (max-width:700px) { .dashboard-charts { grid-template-columns: 1fr; } }
@media (max-width:760px) { .admin-layout { grid-template-columns: 1fr; gap: 0; } .admin-sidebar { position: static; padding: 16px; } .admin-sidebar nav { flex-direction: row; flex-wrap: wrap; gap: 4px; margin: 12px 0; } }


/* Storefront shopping experience */
.site-header header { padding-block: 16px; flex-wrap: wrap; }
.site-header header nav { flex-wrap: wrap; gap: 20px; }
.site-header header nav a { padding-block: 8px; font-size: 13px; }
.category-nav { padding-block: 8px; }
.store-shop.section { padding-block: 16px 32px; }
.store-service { display: flex; justify-content: space-between; flex-wrap: wrap; gap: 10px 20px; border: 1px solid var(--line); background: #fff0dc; border-radius: 8px; padding: 12px 16px; font-size: 12px; margin-bottom: 16px; }
.store-service a { color: var(--accent); }
.store-toolbar { display: grid; grid-template-columns: minmax(200px,2fr) minmax(140px,1fr) minmax(160px,1fr) auto; gap: 14px; align-items: end; }
.store-toolbar label { color: #65545c; font-size: 12px; min-width: 0; }
.store-toolbar input, .store-toolbar select { width: 100%; min-width: 0; min-height: 42px; padding: 10px 12px; margin-top: 6px; border-radius: 6px; background: #fffdfd; }
.store-toolbar .store-available { display: flex; align-items: center; align-self: end; gap: 8px; min-height: 42px; white-space: nowrap; }
.store-toolbar .store-available input { width: 16px; height: 16px; min-height: 0; margin: 0; accent-color: var(--accent); }
.store-results-bar { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 46px; }
.store-results-bar p { margin: 0; font-size: 12px; color: #726269; }
.store-reset { border: 0; background: transparent; padding: 10px 0; color: var(--accent); cursor: pointer; font-size: 12px; text-decoration: underline; }
.store-cake-note { margin: 0 0 16px; font-size: 12px; color: #726269; }
body:not(.admin-view) .store-card { display: flex; flex-direction: column; min-width: 0; background: #fffdfd; border: 1px solid var(--line); border-radius: 12px; overflow: hidden; }
.store-card-media { position: relative; min-width: 0; }
body:not(.admin-view) .store-card .art { display: block; position: relative; width: 100%; min-width: 0; max-width: 100%; height: auto; aspect-ratio: 1.6; margin: 0; border-radius: 0; }
body:not(.admin-view) .store-card .art img { position: absolute; inset: 0; width: 100%; height: 100%; display: block; object-fit: cover; }
.store-stock { position: absolute; top: 12px; left: 12px; background: #fffdfd; color: #65545c; border-radius: 20px; padding: 6px 10px; font-size: 11px; pointer-events: none; }
.store-card-body { display: flex; flex-direction: column; flex: 1; padding: 16px; min-width: 0; overflow-wrap: anywhere; }
.store-card-meta { display: flex; justify-content: space-between; flex-wrap: wrap; gap: 6px; font-size: 11px; color: #726269; margin-bottom: 10px; }
body:not(.admin-view) .store-card h3 { font-size: 22px; line-height: 1.25; margin: 0 0 10px; }
body:not(.admin-view) .store-card .store-card-price { font-size: 18px; font-weight: 600; margin: 0 0 12px; }
.store-card-price small { font-size: 12px; font-weight: 400; color: #726269; }
body:not(.admin-view) .store-card .store-allergens { font-size: 12px; line-height: 1.5; margin: 0 0 12px; color: #726269; }
.store-allergens strong { font-weight: 500; color: #65545c; }
.store-details { padding-top: 12px; border-top: 1px solid var(--line); font-size: 12px; margin-bottom: 16px; }
.store-details > summary { cursor: pointer; line-height: 1.6; color: var(--accent); }
.store-details > div { line-height: 1.6; padding-top: 8px; }
.store-details ul { padding-left: 18px; }
.store-card-actions { margin-top: auto; }
.store-card-actions > .btn { display: flex; align-items: center; justify-content: space-between; width: 100%; min-height: 44px; padding: 12px 14px; border-radius: 6px; }
.store-credit { margin-top: 10px; font-size: 10px; color: #726269; }
.store-credit > summary { cursor: pointer; }
.store-credit .photo-caption { font-size: 10px; margin-top: 6px; }
.store-empty { grid-column: 1 / -1; text-align: center; padding: 40px 16px; border: 1px dashed var(--line); border-radius: 12px; }
.store-shop button:focus-visible, .store-shop summary:focus-visible, .store-shop input:focus-visible, .store-shop select:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
@media (max-width: 1000px) { .store-toolbar { grid-template-columns: minmax(0,2fr) minmax(0,1fr); } }
@media (max-width: 700px) { .store-toolbar { gap: 12px; } .store-toolbar .store-search { grid-column: 1 / -1; } .store-toolbar .store-available { grid-column: 1 / -1; } .store-card-body { padding: 12px; } body:not(.admin-view) .store-card h3 { font-size: 19px; } .store-service { padding: 10px 12px; } }


.hero-video-wrap { position: relative; width: min(100%, 348px); min-width: 0; height: auto; aspect-ratio: 9 / 16; margin-inline: auto; overflow: hidden; border-radius: 16px; background: #e9dfcf url('/media/outdoor-celebration.jpg') center / contain no-repeat; }
#hero-video { position: absolute; inset: 0; display: block; width: 100%; height: 100%; object-fit: contain; object-position: center; }
#hero-video[hidden] { display: none; }
.hero-video-overlay { position: absolute; inset: auto 0 0; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; padding: 60px 20px 36px; background: linear-gradient(transparent, #201d15bb); color: white; pointer-events: none; }
.hero-video-overlay > span { font: 20px Georgia, serif; }
#hero-video-toggle { pointer-events: auto; border: 1px solid #ffffff90; border-radius: 20px; padding: 9px 14px; background: #201d1540; color: white; font-size: 12px; cursor: pointer; min-height: 40px; }
#hero-video-toggle:focus-visible { outline: 2px solid white; outline-offset: 3px; }
.hero-video-credit { position: absolute; bottom: 10px; left: 20px; color: white; font-size: 10px; text-decoration: underline; }
@media (max-width: 700px) { .hero-video-wrap { width: min(100%, 320px); aspect-ratio: 9 / 16; } }


/* Editorial landing structure inspired by the supplied reference. */
.bakery-landing { padding-top: 18px; }
.bakery-landing .hero { grid-template-columns: 1fr 1fr; gap: clamp(24px,4vw,72px); padding: 16px 0 30px; align-items: center; }
.bakery-landing .hero > div:first-child { padding: clamp(12px,2.5vw,40px); min-width: 0; }
.bakery-landing .hero h1 { font-size: clamp(40px,5.1vw,88px); line-height: 1.04; letter-spacing: -2px; margin: 22px 0; }
.bakery-landing .hero > div > p { max-width: 500px; font-size: 16px; line-height: 1.8; color: #726269; }
.bakery-hero-actions { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 28px; }
.bakery-landing .hero .btn { margin: 0; border-radius: 6px; min-height: 46px; }
.bakery-landing .hero .bakery-lead-time { font-size: 12px; margin-top: 18px; }
.bakery-values { display: grid; grid-template-columns: repeat(3,minmax(0,1fr)); gap: 16px; border-block: 1px solid var(--line); padding: 20px 12px; }
.bakery-values > span { display: flex; align-items: center; justify-content: center; gap: 14px; font-size: 13px; }
.bakery-values b, .bakery-index { color: var(--accent); font-size: 11px; font-weight: 400; }
.bakery-section { padding: clamp(32px,4vw,64px) 0; }
.bakery-section-head { display: grid; grid-template-columns: 180px minmax(0,1fr) auto; align-items: start; gap: 24px; margin-bottom: 28px; }
.bakery-section-head .eyebrow { padding-top: 9px; }
.bakery-section-head h2 { font-size: clamp(28px,3.1vw,46px); letter-spacing: -.8px; margin: 0; }
.bakery-section-head p { max-width: 540px; color: #726269; font-size: 14px; line-height: 1.7; margin: 12px 0 0; }
.bakery-section-head > a { padding-top: 10px; font-size: 13px; color: var(--accent); }
.bakery-category-grid { display: grid; grid-template-columns: repeat(3,minmax(0,1fr)); gap: 24px; }
.bakery-category { display: block; min-width: 0; border-bottom: 1px solid var(--line); }
.bakery-category-photo { aspect-ratio: 2; border-radius: 10px; overflow: hidden; background: #f6e6ed; }
.bakery-category-photo img { width: 100%; height: 100%; object-fit: cover; display: block; transition: transform .4s; }
.bakery-category:hover img { transform: scale(1.025); }
.bakery-category-copy { display: grid; grid-template-columns: 22px minmax(0,1fr) 20px; gap: 10px; padding: 18px 0; }
.bakery-index { padding-top: 6px; }
.bakery-category-copy h3 { font-size: 25px; margin: 0 0 8px; }
.bakery-category-copy p { font-size: 13px; line-height: 1.6; color: #726269; margin: 0; }
.bakery-category-copy > span:last-child { color: var(--accent); font-size: 20px; }
.bakery-how { border-top: 1px solid var(--line); }
.bakery-steps { display: grid; grid-template-columns: repeat(3,minmax(0,1fr)); gap: 24px; }
.bakery-steps article { border-top: 1px solid var(--line); padding: 20px 0; }
.bakery-steps article > span { font-size: 12px; color: var(--accent); }
.bakery-steps h3 { font-size: 25px; margin: 16px 0 10px; }
.bakery-steps p { font-size: 14px; color: #726269; line-height: 1.7; max-width: 400px; }
.bakery-closing { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 30px; background: var(--ink); color: var(--cream); border-radius: 14px; padding: clamp(24px,4vw,64px); margin-bottom: 32px; }
.bakery-closing .eyebrow { color: #f3ae55; }
.bakery-closing h2 { font-size: clamp(36px,4vw,64px); letter-spacing: -1px; margin: 20px 0; }
.bakery-closing h2 em { color: #f3ae55; }
.bakery-closing p { max-width: 460px; color: #f3e4eb; font-size: 15px; line-height: 1.8; }
.bakery-closing-actions { display: flex; flex-direction: column; gap: 20px; font-size: 13px; }
.bakery-closing-actions .btn { background: var(--cream); color: var(--ink); border-radius: 6px; }
.bakery-landing a:focus-visible { outline: 2px solid var(--accent); outline-offset: 4px; }
.bakery-closing a:focus-visible { outline-color: var(--cream); }
@media (max-width: 900px) { .bakery-section-head { grid-template-columns: 1fr auto; gap: 16px; } .bakery-section-head > .eyebrow { grid-column: 1 / -1; } .bakery-category-grid { gap: 16px; } }
@media (max-width: 700px) { .bakery-landing .hero { grid-template-columns: 1fr; padding-top: 0; } .bakery-landing .hero h1 { letter-spacing: -1px; } .bakery-category-grid { grid-template-columns: repeat(2,minmax(0,1fr)); } .bakery-values { padding-inline: 0; gap: 8px; } .bakery-values > span { align-items: start; gap: 6px; font-size: 11px; line-height: 1.5; } .bakery-steps { grid-template-columns: 1fr; gap: 8px; } }
@media (max-width: 420px) { .bakery-category-grid { grid-template-columns: 1fr; } .bakery-section-head { grid-template-columns: 1fr; } .bakery-hero-actions { flex-direction: column; } }
@media (prefers-reduced-motion: reduce) { .bakery-category-photo img { transition: none; } .bakery-category:hover img { transform: none; } }


/* Brand palette and supplied artwork */
.site-brand { display: inline-flex; align-items: center; gap: 10px; min-width: 0; }
.brand-logo { display: block; position: relative; flex: 0 0 66px; width: 66px; height: 66px; overflow: hidden; border-radius: 50%; background: var(--cream); }
.brand-logo img { display: block; width: 100%; height: 100%; object-fit: contain; transform: scale(1.6); }
.brand-wordmark { font: bold 27px Georgia, serif; color: var(--ink); }
.brand-wordmark small { display: block; font: 9px Arial,sans-serif; letter-spacing: 2px; margin-top: 7px; color: var(--accent); }
.admin-sidebar .site-brand { display: flex; flex-direction: column; align-items: flex-start; gap: 8px; }
.admin-brand .brand-wordmark { font-size: 23px; }
.footer-brand { margin-bottom: 12px; }
.btn:not(.secondary) { background: var(--brand-orange); color: var(--ink); border-color: var(--brand-orange); }
.btn:not(.secondary):hover { background: #f5a53e; border-color: #f5a53e; }
.secondary:hover { background: #fcecf4; border-color: var(--brand-pink); }
.category-nav a[aria-current="page"] { background: var(--ink); color: var(--cream); box-shadow: inset 0 -3px var(--brand-pink); }
.top { background: var(--ink); color: var(--cream); border-bottom: 3px solid var(--brand-orange); }
.bakery-values b { color: #9b3e6e; }
.bakery-closing { border-top: 4px solid var(--brand-pink); }
.bakery-closing-actions .btn { background: var(--brand-orange); color: var(--ink); }
.bar-track span { background: var(--brand-pink); }
@media (max-width: 480px) { .brand-logo { width: 52px; height: 52px; flex-basis: 52px; } .brand-wordmark { font-size: 23px; } }


.account-auth { max-width: 600px; margin-inline: auto; }
.account-tabs { display: flex; flex-wrap: wrap; gap: 8px; border-bottom: 1px solid var(--line); padding-bottom: 12px; margin-bottom: 24px; }
.account-tabs a { padding: 12px 16px; border-radius: 6px; }
.account-tabs a[aria-current="page"] { background: var(--ink); color: var(--cream); }
.account-tabs a:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }


/* Light and dark themes */
:root { color-scheme: light; }
:root[data-theme="dark"] { color-scheme: dark; --cream: #191619; --surface: #252025; --ink: #f6edf1; --muted: #c5b4bd; --accent: #ffb45e; --line: #4b3b45; }
.theme-toggle { display: inline-grid; place-items: center; width: 44px; height: 44px; min-height: 44px; flex: 0 0 44px; padding: 0; border: 0; border-radius: 50%; background: transparent; color: var(--ink); cursor: pointer; }
.theme-toggle:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
.admin-toolbar { align-items: center; gap: 12px; }
:root[data-theme="dark"] body { color: var(--ink); background: var(--cream); }
:root[data-theme="dark"] :is(.panel,.category-nav,.store-card,.admin-sidebar,.profile-menu > summary,.profile-dropdown,.inline-ingredients,.inline-photo-close,.cake-collections > div) { background: var(--surface); color: var(--ink); }
:root[data-theme="dark"] body:not(.admin-view) .store-card { background: var(--surface); }
:root[data-theme="dark"] :is(input,select,textarea) { background: #211c21; color: var(--ink); border-color: var(--line); }
:root[data-theme="dark"] .store-toolbar :is(input,select) { background: #211c21; }
:root[data-theme="dark"] :is(.store-card-meta,.store-allergens,.store-card-price small,.store-results-bar p,.store-cake-note,.store-toolbar label,.store-credit,.photo-caption,.kpi-card small,.bakery-category-copy p,.bakery-section-head p,.bakery-steps p,.bakery-landing .hero > div > p) { color: var(--muted); }
:root[data-theme="dark"] body:not(.admin-view) .store-card .store-allergens { color: var(--muted); }
:root[data-theme="dark"] :is(.store-allergens strong,.category-art small) { color: var(--ink); }
:root[data-theme="dark"] :is(.store-service,footer,.bar-track) { background: #30232b; color: var(--ink); }
:root[data-theme="dark"] :is(.notice,.badge) { background: #392a24; color: #ffd5a5; border-color: var(--line); }
:root[data-theme="dark"] .error { color: #ffa7b4; }
:root[data-theme="dark"] .btn:not(.secondary) { color: #292326; }
:root[data-theme="dark"] :is(.category-nav a[aria-current="page"],.admin-sidebar nav a[aria-current="page"],.account-tabs a[aria-current="page"]) { background: #f4a23e; color: #292326; }
:root[data-theme="dark"] :is(.category-nav a:hover,.admin-sidebar nav a:hover,.profile-dropdown button:hover,.secondary:hover) { background: #422d3a; }
:root[data-theme="dark"] .top { background: #100e10; color: #f6edf1; }
:root[data-theme="dark"] .bakery-closing { background: #30202b; color: #f6edf1; }
:root[data-theme="dark"] .brand-logo { background: #fffafa; }
:root[data-theme="dark"] .store-stock { background: #30232b; color: #f6edf1; }
:root[data-theme="dark"] .trend-chart text { fill: var(--muted); }

</style>
<link rel="stylesheet" href="/storefront.css">
<link rel="stylesheet" href="/assets/tailwind.css">
</head>

<body>
<div class="site-header">
<div class="top">
  Freshly baked to order · A little 48hr notice
</div>

<header>
  <a class="brand site-brand" href="#/" aria-label="Subanese home"><span class="brand-logo"><img src="/brand/logo.jpeg" alt="" width="80" height="80"></span><span class="brand-wordmark">Subanese<small>WE BAKE, YOU TAKE</small></span></a>

  <nav aria-label="Main navigation">
    <a href="#/shop">Shop</a>
    <a href="#/custom">Custom cakes</a>
  </nav>

  <button type="button" class="theme-toggle" data-theme-toggle aria-label="Switch color theme"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M20.9 13A9 9 0 0 1 11 3.1 9 9 0 1 0 20.9 13Z"/></svg></button>
  <button class="btn secondary" id="bag" aria-haspopup="dialog" aria-controls="cart">
    Cart <span id="count" aria-live="polite" aria-atomic="true">0</span>
  </button>
  <div id="customer-account-menu"><a href="#/account" id="customer-account-link" class="btn secondary">Sign in</a></div>
</header>
<nav id="category-nav" class="category-nav" aria-label="Bakery categories"></nav>
</div>

<main id="main" class="wrap"></main>

<footer>
  <a class="brand site-brand footer-brand" href="#/" aria-label="Subanese home"><span class="brand-logo"><img src="/brand/logo.jpeg" alt="" width="80" height="80"></span><span class="brand-wordmark">Subanese<small>WE BAKE, YOU TAKE</small></span></a>
  <p>A little flour. A little butter. A whole lot of love.</p>
  <p>
    Freshly baked treats for your sweetest moments.
  </p>
</footer>

<dialog id="cart" aria-labelledby="cart-title">
  <div class="row">
    <h2 id="cart-title">Your sweet little bag.</h2>
    <button
      id="close-cart"
      class="close"
      aria-label="Close bag"
    >×</button>
  </div>

  <div id="cart-content"></div>
</dialog>

<dialog id="cake-details" aria-labelledby="cake-title">
  <button type="button" class="close" id="close-cake" aria-label="Close item details">&times;</button>
  <div id="cake-content"></div>
</dialog>

<div id="message" role="status"></div>

<script src="/dashboard-ui.js"></script>
<script src="/assets/storefront.js"></script>
<script>
const $ = selector => document.querySelector(selector);
const main = $("#main");
function syncThemeButtons() {
  const dark = document.documentElement.dataset.theme === 'dark';
  document.querySelectorAll('[data-theme-toggle]').forEach(button => {
    button.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true">' + (dark ? '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/>' : '<path d="M20.9 13A9 9 0 0 1 11 3.1 9 9 0 1 0 20.9 13Z"/>') + '</svg>';
    button.removeAttribute('title');
    button.setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark theme');
  });
}
document.addEventListener('click', event => {
  if (!event.target.closest('[data-theme-toggle]')) return;
  const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem('subanese-theme', theme); } catch {}
  syncThemeButtons();
});
syncThemeButtons();


let products = [];
let currency = "KES";
let deliveryFee = 350;
let bag = [];

try {
  bag = JSON.parse(
    localStorage.getItem("subanese-bag") || "[]"
  );

  if (!Array.isArray(bag)) bag = [];

  bag = bag.filter(
    item =>
      item &&
      Number.isInteger(item.id) &&
      Number.isInteger(item.quantity) &&
      item.quantity > 0
  );
} catch {
  bag = [];
}

const escapeHTML = value =>
  String(value ?? "").replace(
    /[&<>"']/g,
    character => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    }[character])
  );

const money = amount =>
  new Intl.NumberFormat("en", {
    style: "currency",
    currency,
    maximumFractionDigits: 0
  }).format(amount);

async function api(url, method = "GET", data) {
  const response = await fetch("/api" + url, {
    method,
    headers: data
      ? { "Content-Type": "application/json" }
      : {},
    body: data ? JSON.stringify(data) : undefined
  });

  const result = await response.json();

  if (!response.ok) {
    throw Error(result.error || "Request failed.");
  }

  return result;
}

function toast(message) {
  $("#message").textContent = message;
  $("#message").style.display = "block";

  clearTimeout(toast.timer);

  toast.timer = setTimeout(() => {
    $("#message").style.display = "none";
  }, 4000);
}

function saveBag() {
  localStorage.setItem(
    "subanese-bag",
    JSON.stringify(bag)
  );

  $("#count").textContent = bag.reduce(
    (total, item) => total + item.quantity,
    0
  );
  $("#bag").hidden = false;
}

function bagDetails() {
  return bag
    .map(item => ({
      ...item,
      product: products.find(
        product => product.id === item.id
      )
    }))
    .filter(item => item.product);
}

function subtotal() {
  return bagDetails().reduce(
    (total, item) =>
      total + item.product.price * item.quantity,
    0
  );
}

function addToBag(id, preferences) {
  const product = products.find(
    product => product.id === id
  );

  const existing = bag.find(item => item.id === id);

  if (
    (existing?.quantity || 0) >=
    Math.min(product.stock, 50)
  ) {
    return toast("No more available.");
  }

  if (existing) {
    existing.quantity++;
    if (preferences) Object.assign(existing, preferences);
  } else {
    bag.push({ id, quantity: 1, ...preferences });
  }

  saveBag();
  toast("Added a little sweetness to your bag.");
  return true;
}

const ingredientPreferences = ["Cheese / cream cheese", "Milk", "Cream", "Butter", "Yoghurt", "Nuts"];
function preferenceSummary(item) {
  const excluded = Array.isArray(item.excluded) ? item.excluded : [];
  return (excluded.length || item.notes) ? '<p class="small">Bakery confirmation needed. ' +
    (excluded.length ? 'Request without: ' + escapeHTML(excluded.join(', ')) + '. ' : '') +
    escapeHTML(item.notes || '') + '</p>' : '';
}

function showProduct(id, edit = false) {
  const product = products.find(p => p.id === id);
  if (!product) return;
  rememberViewedProduct(id);
  const existing = bag.find(item => item.id === id);
  const excluded = existing?.excluded || [];
  $('#cart').close();
  $('#cake-content').innerHTML =
    '<h2 id="cake-title">' + escapeHTML(product.name) + '</h2>' +
    photoImage(productPhoto(product), 'cake-detail-photo') + stockPhotoCredit(productPhoto(product).source) +
    '<p>' + escapeHTML(product.category) + ' &middot; 48 hours notice</p><p class="price">' + money(product.price) + (cakeMenu.some(group => group.items.some(item => item.id === id)) ? ' / 1 kg cake' : '') + '</p><p>' + (product.stock ? product.stock + ' available' : 'Sold out') + '</p>' +
    '<h3>Ingredients &amp; allergens</h3>' + ingredientList(product) + '<p>Allergens: ' + escapeHTML(product.allergens || 'Please confirm with the bakery') + '.</p>' +
    '<form id="cake-preferences"><fieldset><legend>Ingredient preferences</legend>' +
    '<p>Checked means no change requested. Uncheck ingredients you want the bakery to omit or substitute, if present. These are preference options, not a recipe list.</p>' +
    ingredientPreferences.map((name, index) => '<label class="ingredient-option"><input type="checkbox" name="ingredient" value="' + index + '" ' + (excluded.includes(name) ? '' : 'checked') + '>' + escapeHTML(name) + '</label>').join('') +
    '</fieldset><p class="notice">Changes need bakery confirmation. Removing cheese alone does not make an item lactose-free: other ingredients may contain dairy. Shared-kitchen cross-contact is possible.</p>' +
    '<label>Dietary needs or substitution requests<textarea name="notes" maxlength="500" placeholder="Tell us about lactose intolerance, allergies, or preferred substitutes">' + escapeHTML(existing?.notes || '') + '</textarea></label>' +
    '<p class="small">Preferences apply to all quantities of this item in your bag. Price shown is the standard recipe price; the bakery must confirm any substitution cost.</p>' +
    '<button class="btn" ' + (!product.stock && !edit ? 'disabled' : '') + '>' + (edit ? 'Save preferences' : 'Add to bag &middot; ' + money(product.price)) + '</button></form>';
  $('#cake-preferences').onsubmit = event => {
    event.preventDefault();
    const form = event.target;
    const preferences = {
      excluded: Array.from(form.querySelectorAll('input[name="ingredient"]')).filter(input => !input.checked).map(input => ingredientPreferences[Number(input.value)]),
      notes: form.elements.notes.value.trim()
    };
    if (edit && existing) { Object.assign(existing, preferences); saveBag(); }
    else {
      if (!addToBag(id, preferences)) return;
    }
    $('#cake-details').close();
    if (edit) openBag();
  };
  $('#cake-details').showModal();
}

const stockPhotos = {
  Cakes: [30877403, 'Decorated celebration cake'],
  Cupcakes: [7552317, 'Handmade cupcakes on display'],
  Cookies: [19501303, 'Chocolate chip cookies on a plate'],
  Pastries: [27969779, 'Fresh croissants in a bakery'],
  Bread: [6605201, 'Artisanal sourdough loaves'],
  Rolls: [6601710, 'Fresh bread rolls on a plate'],
  Mahamri: [35017917, 'Fried dough balls: illustrative placeholder for Mahamri'],
  Doughnuts: [1191639, 'Assorted decorated doughnuts']
};
const originalProductPhotos = {
  1: [369267, 'Chocolate cake with colourful candles'],
  2: [6211106, 'Celebration cake decorated with berries']
};
function pexelsImage(id, width = 800) {
  return 'https://images.pexels.com/photos/' + id + '/pexels-photo-' + id + '.jpeg?auto=compress&cs=tinysrgb&w=' + width;
}
function productPhoto(product) {
  if (product.image_url) return {image: product.image_url, alt: product.name, source: null};
  const cake = cakeMenu.flatMap(group => group.items).find(cake => cake.id === product.id);
  if (cake) return { image: cake.image, alt: cake.photo.alt, source: cake.photo.source };
  const photo = originalProductPhotos[product.id] || stockPhotos[product.category] || stockPhotos.Pastries;
  return { image: pexelsImage(photo[0]), alt: photo[1], source: 'https://www.pexels.com/photo/' + photo[0] + '/' };
}
function stockPhotoCredit(source) {
  if (!source) return '';
  return '<p class="small">Illustrative photo ? <a href="' + escapeHTML(source) + '" target="_blank" rel="noopener noreferrer" style="text-decoration:underline">Pexels</a></p>';
}
function imageSources(url, sizes) {
  if (!url.startsWith('https://images.pexels.com/')) return '';
  const sized = width => url.replace(/([?&])w=\d+/, '$1w=' + width);
  return ' srcset="' + [400,800,1200].map(width => escapeHTML(sized(width)) + ' ' + width + 'w').join(', ') + '" sizes="' + sizes + '"';
}
function photoImage(photo, className = '') {
  return '<img class="' + className + '" src="' + escapeHTML(photo.image) + '" alt="' + escapeHTML(photo.alt) + '" loading="lazy" decoding="async" onerror="this.hidden=true;this.nextElementSibling.hidden=false"><small hidden>Image unavailable</small>';
}

function showProductImage(id) {
  const product = products.find(product => product.id === id);
  const thumbnail = document.querySelector('[data-image="' + id + '"]');
  if (!product || !thumbnail) return;
  document.querySelectorAll('.inline-photo-preview').forEach(preview => preview.querySelector('button').click());
  const photo = productPhoto(product);
  const largePhoto = {...photo, image: photo.image.replace(/([?&])w=\d+/, '$1w=1600')};
  const preview = document.createElement('div');
  preview.className = 'inline-photo-preview';
  preview.innerHTML = photoImage(largePhoto) + '<button type="button" class="inline-photo-close" aria-label="Close enlarged photo">&times;</button>';
  thumbnail.hidden = true;
  thumbnail.insertAdjacentElement('afterend', preview);
  const close = preview.querySelector('button');
  const dismissOnClick = () => dismiss(false);
  function dismiss(restoreFocus) {
    document.removeEventListener('click', dismissOnClick, true);
    preview.remove();
    thumbnail.hidden = false;
    if (restoreFocus) thumbnail.focus({preventScroll: true});
  }
  close.onclick = () => dismiss(true);
  document.addEventListener('click', dismissOnClick, true);
  preview.onkeydown = event => { if (event.key === 'Escape') { event.preventDefault(); close.click(); } };
  close.focus({preventScroll: true});
}

function ingredientList(product) {
  const items = (product.ingredients || '').split(/[,;\n]+/).map(value => value.trim()).filter(Boolean);
  return items.length ? '<ul>' + items.map(value => '<li>' + escapeHTML(value) + '</li>').join('') + '</ul>' : '<p>Full ingredient list: please confirm with the bakery.</p>';
}

function inlineIngredientDetails(product) {
  if (!product) return '';
  return '<button type="button" class="cake-options" data-ingredients="' + product.id +
    '" aria-expanded="false" aria-controls="ingredients-' + product.id + '">Ingredients &amp; options</button>' +
    '<div id="ingredients-' + product.id + '" class="inline-ingredients" hidden>' +
      '<p><strong>Ingredients &amp; allergens</strong></p>' +
      ingredientList(product) + '<ul><li>Allergens: ' + escapeHTML(product.allergens || 'Please confirm with the bakery') + '</li>' +
      '<li>Full ingredient list and substitutions: please confirm with the bakery.</li>' +
      '<li>Shared-kitchen cross-contact is possible.</li></ul>' +
      '<p class="small">Dietary requests can be added in the item details or edited in your bag.</p>' +
    '</div>';
}

function productCards(list) {
  return list.map(product => '<article class="product store-card minimal-product"><button type="button" class="minimal-product-link" data-product="' + product.id + '" aria-haspopup="dialog" aria-controls="cake-details" aria-label="View details for ' + escapeHTML(product.name) + (!product.stock ? ' (sold out)' : '') + '">' +
    '<span class="minimal-product-name">' + escapeHTML(product.name) + '</span><span class="minimal-product-image">' + photoImage(productPhoto(product)) + '</span>' +
    '<span class="minimal-product-price">' + money(product.price) + (product.category === 'Cakes' ? ' <small>/ 1 kg cake</small>' : '') + '</span></button><button type="button" class="btn minimal-add" data-add="' + product.id + '" aria-label="Add ' + escapeHTML(product.name) + ' to bag"' + (!product.stock ? ' disabled' : '') + '>' + (product.stock ? 'Add to bag +' : 'Sold out') + '</button></article>').join('');
}

function bindAddButtons() {
  window.SubaneseUI?.mountProductCards({
    products, photo: product => photoImage(productPhoto(product)), money,
    onDetails: showProduct, onAdd: addToBag,
  });
  document.querySelectorAll('[data-ingredients]').forEach(button => {
    button.onclick = () => {
      const details = $('#ingredients-' + button.dataset.ingredients);
      details.hidden = !details.hidden;
      button.setAttribute('aria-expanded', String(!details.hidden));
    };
  });
  document.querySelectorAll('[data-product]').forEach(button => { if (!button.closest('[data-react-product]')) button.onclick = () => showProduct(Number(button.dataset.product)); });
  document.querySelectorAll('[data-image]').forEach(button => { button.onclick = () => showProductImage(Number(button.dataset.image)); });
  document.querySelectorAll("[data-add]").forEach(
    button => {
      if (button.closest('[data-react-product]')) return;
      button.onclick = () =>
        addToBag(Number(button.dataset.add));
    }
  );
}

function recentlyViewedProducts() {
  try {
    const ids = JSON.parse(localStorage.getItem('subanese-viewed') || '[]');
    return Array.isArray(ids) ? [...new Set(ids)].filter(Number.isSafeInteger).map(id => products.find(product => product.id === id)).filter(Boolean).slice(0,4) : [];
  } catch { return []; }
}
function rememberViewedProduct(id) {
  try { const ids = [id,...recentlyViewedProducts().map(product=>product.id).filter(value=>value!==id)]; localStorage.setItem('subanese-viewed',JSON.stringify(ids.slice(0,4))); } catch {}
}
function recentlyViewedMarkup() {
  const recent = recentlyViewedProducts();
  return recent.length ? '<section class="premium-section" aria-labelledby="recent-title"><div class="premium-section-heading"><div><h2 id="recent-title">Recently viewed</h2><p class="small">Saved on this browser only.</p></div><button type="button" id="clear-recent" class="btn secondary">Clear history</button></div><div class="grid">'+productCards(recent)+'</div></section>' : '';
}

function homePage() {
  const featured = [...products.filter(product => product.stock > 0), ...products.filter(product => !product.stock)].slice(0,4);
  const cake = products.find(product => product.category === 'Cakes' && product.stock > 0) || products[0];
  const photo = cake ? productPhoto(cake) : {image:bakeryCategories[0].image,alt:bakeryCategories[0].photoAlt};
  main.innerHTML = '<div class="premium-home discovery-home"><form id="home-search" class="discovery-search" role="search"><label for="home-search-input">Find your next sweet favourite</label><div><input id="home-search-input" name="q" type="search" placeholder="Search cakes, cookies, flavours..." maxlength="100"><button class="btn" type="submit">Search the bakery</button></div></form>' +
    '<section class="discovery-categories" aria-labelledby="browse-title"><div class="premium-section-heading"><h2 id="browse-title">Shop by category</h2><a class="text-link" href="#/shop">See all &rarr;</a></div><div class="discovery-category-grid">' + bakeryCategories.map(category => '<a class="premium-category" href="#/shop?category=' + encodeURIComponent(category.name) + '"><img src="' + escapeHTML(category.image) + '" alt="' + escapeHTML(category.photoAlt) + '" width="220" height="220" loading="lazy" decoding="async"><h3>' + escapeHTML(category.name) + '</h3></a>').join('') + '</div></section>' +
    '<section class="premium-hero discovery-hero" aria-labelledby="home-title"><div class="premium-hero-copy"><span class="eyebrow">Subanese &middot; We bake, you take</span><h1 id="home-title">Make room for<br><em>sweet moments.</em></h1><p>Cakes for your celebrations. Little treats for your everyday. Find something delicious to share.</p><div class="premium-actions"><a class="btn" href="#/shop">Shop the bakes &rarr;</a><a class="btn secondary" href="#/custom">Create a custom cake</a></div><p class="premium-order-note">At least 48 hours of notice &middot; Pickup or delivery</p></div><figure class="premium-hero-media"><img src="' + escapeHTML(photo.image) + '" alt="' + escapeHTML(photo.alt) + '" width="800" height="800" fetchpriority="high" decoding="async"><figcaption>' + (cake ? escapeHTML(cake.name) : 'From our bakery') + '</figcaption></figure></section>' +
    '<section class="premium-section" aria-labelledby="featured-title"><div class="premium-section-heading"><div><span class="eyebrow">Explore the selection</span><h2 id="featured-title">Featured bakes</h2></div><a class="text-link" href="#/shop">See all bakes &rarr;</a></div><div class="grid premium-featured">' + (featured.length?productCards(featured):'<p>Our selection will appear here when items are available.</p>') + '</div></section>' +
    recentlyViewedMarkup() + '<section class="premium-custom"><div><span class="eyebrow">Something personal</span><h2>Your occasion.<br><em>Your kind of cake.</em></h2><p>Share your flavours, design ideas, and celebration date.</p><a class="btn" href="#/custom">Create a custom cake &rarr;</a></div><div class="premium-custom-note"><span>Made for</span><strong>the moments<br>you share.</strong></div></section>' +
    '<section class="premium-section"><div class="premium-section-heading"><h2>Good things, made simple.</h2></div><ol class="premium-steps"><li><h3>Choose your bakes</h3><p>Browse the bakery and add your preferences.</p></li><li><h3>Select your date and details</h3><p>Allow at least 48 hours before your occasion.</p></li><li><h3>Pickup or delivery</h3><p>Choose how to receive your order at checkout.</p></li></ol></section></div>';
  document.querySelector('.site-header #home-search')?.remove();
  $('.site-header').appendChild($('#home-search'));
  $('#clear-recent')?.addEventListener('click', () => { try { localStorage.removeItem('subanese-viewed'); } catch {} homePage(); });
  $('#home-search').onsubmit = event => {
    event.preventDefault();
    const query = $('#home-search-input').value.trim();
    location.hash = '#/shop' + (query ? '?q=' + encodeURIComponent(query) : '');
  };
  bindAddButtons();
  main.insertAdjacentHTML('beforeend', '<div id="shop-section"></div><div id="custom-section"></div>');
  shopPage($('#shop-section'));
  customCakePage($('#custom-section'));
}

// Category photos can be supplied later by setting each image URL.
// Keep categories separate from purchasable products and their prices/stock.
const bakeryCategories = [
  { name: "Cakes", icon: "🎂", image: "", description: "Celebration cakes, made for your special moments." },
  { name: "Cupcakes", icon: "🧁", image: "", description: "Little treats for parties, gifts, and everyday joy." },
  { name: "Rolls", icon: "🥮", image: "", description: "Soft, freshly baked rolls for sharing." },
  { name: "Cookies", icon: "🍪", image: "", description: "Sweet bites, baked with care." },
  { name: "Mahamri", icon: "◇", image: "", description: "A comforting favourite for your table." },
  { name: "Doughnuts", icon: "🍩", image: "", description: "A little sweetness in every bite." }
].map(category => ({
  ...category,
  image: pexelsImage(stockPhotos[category.name][0]),
  photoAlt: stockPhotos[category.name][1],
  photoSource: 'https://www.pexels.com/photo/' + stockPhotos[category.name][0] + '/'
}));

// Licensed stock references; replace with bakery photography when available.
const cakePhotos = {
  "Vanilla Chocolate": [2680602, "Marbled chocolate and vanilla cake slice"],
  "Vanilla Cardamom": [6794609, "White celebration cake with berries and flowers"],
  "Vanilla Strawberry": [15497539, "Cake topped with strawberries and mixed berries"],
  "Chocolate Chip": [7525196, "Chocolate drip cake with white cream and berries"],
  "Yoghurt Vanilla": [8846914, "Light sponge cake slice with cream and berries"],
  "Cream and Cookie": [19526812, "Cream-filled layered cake slice with berries"],
  "Peppermint Chocolate": [37418888, "Chocolate cake slice with mint garnish"],
  "Double Chocolate": [132694, "Rich chocolate cake on a plate"],
  "Blackforest Cake": [17112294, "Dark layered cake with cherries and cream"],
  "Red Velvet Cake": [34801225, "Red velvet celebration cake with blue ribbon"],
  "Chocolate Orange": [4403073, "Chocolate celebration cake with strawberry decoration"],
  "Passion Curd": [4722014, "Small cake decorated with colourful fresh fruit"],
  "Lemon Blueberry with Poppy Seeds": [8478182, "Frosted citrus sponge cake with lime slices"],
  "Pinnacolada": [20017096, "Coconut cake with fresh strawberries"],
  "Blueberry Cake": [19534490, "Blueberry cake with ombre icing"],
  "Orange Curd with Poppy Seeds": [12261129, "Frosted orange cake on a decorative stand"],
  "Lemon Curd": [5635698, "Lemon cakes with mint leaves"],
  "Carrot Cake": [5741917, "Carrot cake with cream cheese frosting and spices"],
  "Fruit Cake": [18613263, "Round cake topped with mixed fruit and chocolate"],
  "Caramel Spice Cake": [17820840, "Layered caramel cake slice with popcorn garnish"],
  "Fudge Cake": [20377567, "Molten chocolate cake dusted with powdered sugar"],
  "Butterscotch": [40443274, "Golden cake decorated with powdered sugar and lemon"],
  "Rainbow & Confetti": [32191353, "Colourful birthday cake with decorative icing"]
};

const cakeMenu = ${JSON.stringify(cakeCatalog)}.map(group => ({ ...group, items: group.items.map(({ id, name, price }) => ({
  id, name, price,
  image: "https://images.pexels.com/photos/" + cakePhotos[name][0] + "/pexels-photo-" + cakePhotos[name][0] + ".jpeg?auto=compress&cs=tinysrgb&w=800",
  photo: { source: "https://www.pexels.com/photo/" + cakePhotos[name][0] + "/", alt: cakePhotos[name][1] }
})) }));

function cakeCollections(search) {
  return cakeMenu.map(group => {
    const items = group.items.map(cake => {
      const product = products.find(product => product.id === cake.id && product.category === 'Cakes');
      return product ? {...cake, name: product.name, price: product.price} : null;
    }).filter(cake => cake &&
      (group.collection + " " + cake.name).toLowerCase().includes(search)
    );
    if (!items.length) return "";
    return '<section class="cake-menu-group"><h3>' + escapeHTML(group.collection) +
      '</h3><div class="grid">' + items.map(cake =>
        '<article class="product"><button class="cake-preview art category-art" data-image="' + cake.id + '" aria-label="Enlarge photo of ' + escapeHTML(cake.name) + '">' +
        photoImage(productPhoto(products.find(product => product.id === cake.id) || cake)) +
        '</button>' + stockPhotoCredit(productPhoto(products.find(product => product.id === cake.id) || cake).source) + '<h3><button type="button" class="product-title" data-product="' + cake.id + '">' + escapeHTML(cake.name) + '</button></h3>' + inlineIngredientDetails(products.find(product => product.id === cake.id)) + '<p class="price">' +
        money(products.find(product => product.id === cake.id)?.price ?? cake.price) + ' <small>/ kg</small></p>' +
        '<p class="small">Quantity: one 1 kg cake per item. Ask the bakery about ingredients and allergens.</p>' +
        '<button class="btn secondary" data-add="' + cake.id + '" ' +
        (!products.find(product => product.id === cake.id)?.stock ? 'disabled' : '') + '>' +
        (products.find(product => product.id === cake.id)?.stock ? 'Add to bag +' : 'Sold out') + '</button></article>'
      ).join("") + '</div></section>';
  }).join("") || '<p>No cakes match your search.</p>';
}

function categoryCards(list) {
  return list.map(category =>
    '<a class="product category-card" href="#/shop?category=' +
      encodeURIComponent(category.name) + '">' +
      '<div class="art category-art">' +
        (category.image
          ? '<img src="' + escapeHTML(category.image) + '" alt="' +
            escapeHTML(category.photoAlt) + '" loading="lazy" decoding="async" onerror="this.hidden=true;this.nextElementSibling.hidden=false"><small hidden>Image unavailable</small>'
          : '<span aria-hidden="true">' + category.icon + '</span>' +
            '<small>Photo coming soon</small>') +
      '</div>' +
      '<h3>' + escapeHTML(category.name) + '</h3>' +
      '<p>' + escapeHTML(category.description) + '</p>' +
      '<span class="category-link">Explore category →</span>' +
    '</a>'
  ).join("");
}

function renderCategoryNavigation() {
  const navigation = $('#category-nav');
  const route = location.hash.split('?')[0] || '#/';
  if (!['#/', '#/shop', '#/custom'].includes(route)) { navigation.innerHTML = ''; navigation.hidden = true; return; }
  navigation.hidden = false;
  const selected = route === '#/shop' ? new URLSearchParams(location.hash.split('?')[1] || '').get('category') || 'All' : '';
  const categories = [...new Set([...bakeryCategories.map(category=>category.name), ...products.map(product=>product.category)])];
  navigation.innerHTML = '<details class="category-menu"><summary><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M8 6h13M8 12h13M8 18h13M3 6h1M3 12h1M3 18h1"/></svg>All categories<svg class="category-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></summary><div class="category-menu-links"><a href="#/shop"'+(selected==='All'?' aria-current="page"':'')+'>All bakes</a>'+categories.map(category=>'<a href="#/shop?category='+encodeURIComponent(category)+'"'+(selected===category?' aria-current="page"':'')+'>'+escapeHTML(category)+'</a>').join('')+'</div></details>';
  const menu = navigation.querySelector('details');
  menu.onkeydown = event => { if(event.key==='Escape'){menu.open=false;menu.querySelector('summary').focus();} };
  menu.onfocusout = event => { if(!menu.contains(event.relatedTarget)) menu.open=false; };
  navigation.querySelectorAll('a').forEach(link=>link.onclick=()=>{menu.open=false;if(link.getAttribute('href')===location.hash)$('#shop-section')?.scrollIntoView({block:'start'});});
}
document.addEventListener('pointerdown', event => {
  const menu = document.querySelector('.category-menu');
  if(menu && !menu.contains(event.target)) menu.open=false;
});

function shopPage(target = main) {
  const selected = new URLSearchParams(location.hash.split('?')[1] || '').get('category') || 'All';
  const categories = [...new Set([...bakeryCategories.map(category => category.name), ...products.map(product => product.category)])];
  const pageSize = target === main ? 16 : Math.max(1, products.length);
  let page = 1;
  target.innerHTML = '<section class="section store-shop" aria-label="Bake shop"><div class="store-service"><span>Made to order &middot; 48h notice</span><span>Pickup or delivery</span><a href="#/custom">Need a custom cake? &nearr;</a></div>' +
    '<h2>Shop the bakery</h2><div class="store-toolbar"><label class="store-search">Search the bakery<input id="search" type="search" placeholder="Try chocolate, vanilla, or cookies"></label><label>Category<select id="category"><option>All</option>' + categories.map(category => '<option>' + escapeHTML(category) + '</option>').join('') + '</select></label>' +
    '<label>Sort by<select id="store-sort"><option value="featured">Featured</option><option value="price-low">Price: low to high</option><option value="price-high">Price: high to low</option><option value="name">Name: A to Z</option></select></label><label class="store-available"><input id="store-available" type="checkbox"> In stock only</label></div>' +
    '<div class="store-results-bar"><p id="product-count" aria-live="polite"></p><button type="button" id="clear-store-filters" class="store-reset" hidden>Clear filters</button></div><div id="category-detail"></div><div class="grid" id="products"></div><nav id="product-pagination" class="product-pagination" aria-label="Product pages"></nav></section>';
  $('#category').value = categories.includes(selected) ? selected : 'All';
  $('#search').value = new URLSearchParams(location.hash.split('?')[1] || '').get('q') || '';
  function draw() {
    const category = $('#category').value;
    const search = $('#search').value.trim().toLowerCase();
    const stock = $('#store-available').checked;
    renderCategoryNavigation(category);
    const list = products.filter(item => {
      const collection = cakeMenu.find(group => group.items.some(cake => cake.id === item.id))?.collection || '';
      return (category === 'All' || item.category === category) && (!stock || item.stock > 0) && (item.name + ' ' + item.category + ' ' + collection).toLowerCase().includes(search);
    });
    const sort = $('#store-sort').value;
    if (sort === 'price-low') list.sort((a,b) => a.price-b.price);
    if (sort === 'price-high') list.sort((a,b) => b.price-a.price);
    if (sort === 'name') list.sort((a,b) => a.name.localeCompare(b.name));
    const pages = Math.max(1, Math.ceil(list.length / pageSize));
    page = Math.min(page,pages);
    const start = (page-1)*pageSize;
    $('#products').innerHTML = list.length ? productCards(list.slice(start,start+pageSize)) : '<div class="store-empty"><h3>No treats found</h3><p>Try another search or clear your filters to see all available bakes.</p><button type="button" class="btn secondary" id="reset-empty-search">Show all bakes</button></div>';
    $('#category-detail').innerHTML = category === 'Cakes' ? '<p class="store-cake-note">Cake prices are per kilogram &middot; Softcream included; other frostings cost extra.</p>' : '';
    $('#product-count').textContent = list.length ? (category === 'All' ? 'All bakes' : category) + ' ? ' + (start+1) + '-' + Math.min(start+pageSize,list.length) + ' of ' + list.length + ' items' : 'No matching items';
    $('#clear-store-filters').hidden = !search && category === 'All' && !stock && sort === 'featured';
    $('#product-pagination').innerHTML = pages > 1 ? '<button type="button" class="btn secondary" id="previous-products"' + (page === 1 ? ' disabled' : '') + '>&larr; Previous</button><span aria-live="polite">Page ' + page + ' of ' + pages + '</span><button type="button" class="btn secondary" id="next-products"' + (page === pages ? ' disabled' : '') + '>Next &rarr;</button>' : '';
    const changePage = delta => { page += delta; draw(); scrollToItems(); $('#product-pagination button:not(:disabled)')?.focus({preventScroll:true}); };
    if ($('#previous-products')) $('#previous-products').onclick = () => changePage(-1);
    if ($('#next-products')) $('#next-products').onclick = () => changePage(1);
    if ($('#reset-empty-search')) $('#reset-empty-search').onclick = reset;
    bindAddButtons();
  }
  function reset() { page=1; $('#search').value=''; $('#category').value='All'; $('#store-available').checked=false; $('#store-sort').value='featured'; draw(); }
  function scrollToItems() {
    const headerHeight = $('.site-header').getBoundingClientRect().height;
    window.scrollTo({top: Math.max(0,window.scrollY+$('#product-count').getBoundingClientRect().top-headerHeight-16),behavior:'instant'});
  }
  $('#search').oninput = () => {page=1;draw();};
  ['#category','#store-sort','#store-available'].forEach(selector => $(selector).onchange = () => {page=1;draw();});
  $('#clear-store-filters').onclick = reset;
  draw();
}

function openBag() {
  $("#cake-details").close();
  renderBag();
  if (!$("#cart").open) $("#cart").showModal();
}

function renderBag() {
  const lines = bagDetails();

  $("#cart-content").innerHTML = lines.length
    ? lines.map(item =>
        '<div class="line row">' +
          '<div><strong>' +
            escapeHTML(item.product.name) +
          '</strong><br>' +
            money(item.product.price * item.quantity) + preferenceSummary(item) +
            '<button class="cake-options" data-edit-cake="' + item.id + '">Edit preferences</button>' +
          '</div>' +
          '<div class="qty">' +
            '<button data-qty="' + item.id +
              '" data-change="-1" ' +
              'aria-label="Decrease quantity">−</button>' +
            item.quantity +
            '<button data-qty="' + item.id +
              '" data-change="1" ' +
              'aria-label="Increase quantity">+</button>' +
          '</div>' +
        '</div>'
      ).join("") +
      '<h3>Subtotal ' + money(subtotal()) + '</h3>' +
      '<button type="button" class="btn secondary" id="clear-cart">Clear cart</button>' +
      '<p class="small">Delivery is ' +
        money(deliveryFee) +
        '. Pickup is free.</p>' +
      '<a class="btn" href="#/checkout" id="checkout-link">' +
        'Checkout ↗</a>'
    : "<p>Your bag is waiting for something lovely.</p>";

  $('#clear-cart')?.addEventListener('click', () => {
    bag = [];
    saveBag();
    renderBag();
    $('#close-cart').focus();
    toast('Cart cleared.');
  });
  document.querySelectorAll("[data-edit-cake]").forEach(button => { button.onclick = () => showProduct(Number(button.dataset.editCake), true); });
  document.querySelectorAll("[data-qty]").forEach(
    button => {
      button.onclick = () => {
        const item = bag.find(
          item => item.id === Number(button.dataset.qty)
        );

        const product = products.find(
          product => product.id === item.id
        );

        const quantity =
          item.quantity + Number(button.dataset.change);

        if (quantity > Math.min(product.stock, 50)) {
          return toast("That quantity is unavailable.");
        }

        item.quantity = quantity;
        bag = bag.filter(item => item.quantity > 0);

        saveBag();
        renderBag();
      };
    }
  );

  $("#checkout-link")?.addEventListener(
    "click",
    () => $("#cart").close()
  );
}

function minimumDate() {
  return new Date(
    Date.now() + 72 * 3600000
  ).toISOString().slice(0, 10);
}

function customerFields() {
  return (
    '<label>Your name' +
      '<input name="name" required maxlength="100" ' +
        'autocomplete="name"></label>' +
    '<label>Email' +
      '<input name="email" type="email" required ' +
        'autocomplete="email"></label>'
  );
}

function deliveryLink(pin) {
  if (!pin || !Number.isFinite(pin.lat) || !Number.isFinite(pin.lng)) return '';
  return '<a class="cake-options" target="_blank" rel="noopener noreferrer" href="https://www.google.com/maps/dir/?api=1&amp;destination=' + encodeURIComponent(pin.lat + ',' + pin.lng) + '">Navigate to delivery pin</a>';
}

function checkoutPage() {
  if (!bagDetails().length) {
    location.hash = "#/shop";
    return;
  }

  main.innerHTML =
    '<section class="section">' +
      '<span class="eyebrow">Almost time to celebrate</span>' +
      '<h1>The sweetest checkout.</h1>' +
      '<div class="two">' +
        '<form id="checkout-form" class="panel">' +
          '<div class="fields">' +
            customerFields() +
            '<label>Phone<input name="phone" type="tel" ' +
              'required maxlength="40"></label>' +
            '<label>Your date<input name="date" type="date" ' +
              'min="' + minimumDate() + '" required></label>' +
            '<label>Fulfillment' +
              '<select name="method" id="method">' +
                '<option value="pickup">Pickup · free</option>' +
                '<option value="delivery">Delivery · ' +
                  money(deliveryFee) + '</option>' +
              '</select>' +
            '</label>' +
            '<label class="wide" id="address-field" hidden>Building, street &amp; delivery directions (optional)' +
              '<input name="address" id="address" ' +
                'maxlength="500" placeholder="Building name, gate, floor, nearby landmark"></label>' +
            '<div class="wide" id="delivery-map-action" hidden><button type="button" class="btn secondary" id="open-delivery-map" aria-controls="delivery-picker" aria-expanded="false">' +
              '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 1 1 16 0Z"/><circle cx="12" cy="10" r="3"/></svg>' +
              'Select location on map</button><p id="delivery-pin-summary" class="small">No delivery location selected.</p></div>' +
            '<div class="wide" id="delivery-picker" hidden><h3>Select your delivery location</h3>' +
              '<p>Tap the map to place your pin, or use your current location. Drag the pin to the delivery entrance.</p>' +
              '<button type="button" class="btn secondary" id="locate-delivery">Use my current location</button>' +
              '<div id="delivery-map" tabindex="-1" aria-label="Choose delivery location on the map"></div>' +
              '<p id="delivery-map-status" role="status">No delivery pin selected.</p>' +
              '<button type="button" class="cake-options" id="pin-map-center">Use map centre</button>' +
              '<details><summary>Enter map coordinates manually</summary><div class="fields">' +
                '<label>Latitude<input id="delivery-lat" type="number" step="any" min="-90" max="90"></label>' +
                '<label>Longitude<input id="delivery-lng" type="number" step="any" min="-180" max="180"></label></div>' +
                '<button type="button" class="btn secondary" id="set-delivery-coordinates">Set delivery pin</button></details>' +
              '<p class="small">Your selected pin will be saved with the order for delivery navigation.</p></div>' +
          '</div>' +
          '<p class="small">Allergen details appear on each ' +
            'product. Shared-kitchen cross-contact is possible.</p>' +
          '<p id="checkout-error" class="error" role="alert"></p>' +
          '<button class="btn">Confirm order</button>' +
        '</form>' +
        '<aside class="panel">' +
          '<h2>Your little treats.</h2>' +
          bagDetails().map(item =>
            '<div class="line row">' +
              '<span>' + escapeHTML(item.product.name) +
                ' × ' + item.quantity + preferenceSummary(item) + '</span>' +
              '<span>' +
                money(item.quantity * item.product.price) +
              '</span>' +
            '</div>'
          ).join("") +
          '<h3 id="total">Total ' + money(subtotal()) + '</h3>' +
        '</aside>' +
      '</div>' +
    '</section>';

  let deliveryLocation = null;
  let deliveryMap = null;
  let deliveryMarker = null;
  const mapStatus = message => { $('#delivery-map-status').textContent = message; };
  function setDeliveryPin(lat, lng) {
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      mapStatus('Enter valid latitude and longitude coordinates.'); return;
    }
    deliveryLocation = {lat: Number(lat.toFixed(6)), lng: Number(lng.toFixed(6))};
    $('#delivery-lat').value = deliveryLocation.lat;
    $('#delivery-lng').value = deliveryLocation.lng;
    $('#delivery-pin-summary').textContent = 'Delivery pin selected: ' + deliveryLocation.lat + ', ' + deliveryLocation.lng;
    mapStatus('Selected pin: ' + deliveryLocation.lat + ', ' + deliveryLocation.lng + '. Check the entrance before confirming.');
    if (deliveryMap) {
      if (!deliveryMarker) {
        deliveryMarker = L.marker([lat, lng], {draggable: true}).addTo(deliveryMap);
        deliveryMarker.on('dragend', () => { const point = deliveryMarker.getLatLng(); setDeliveryPin(point.lat, point.lng); });
      } else deliveryMarker.setLatLng([lat, lng]);
      deliveryMap.panTo([lat, lng]);
    }
  }
  function initializeDeliveryMap() {
    if (deliveryMap) { deliveryMap.invalidateSize(); return; }
    if (typeof L === 'undefined') {
      mapStatus('Map could not load. Try again with an internet connection, use your current location, or enter map coordinates manually.');
      $('#pin-map-center').disabled = true; return;
    }
    deliveryMap = L.map('delivery-map', {scrollWheelZoom: false}).setView([-1.286389, 36.817223], 12);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    }).on('tileerror', () => mapStatus('Map tiles could not load. Use your current location or enter coordinates manually.')).addTo(deliveryMap);
    deliveryMap.on('click', event => setDeliveryPin(event.latlng.lat, event.latlng.lng));
    if (deliveryLocation) setDeliveryPin(deliveryLocation.lat, deliveryLocation.lng);
  }
  $('#pin-map-center').onclick = () => {
    if (deliveryMap) { const point = deliveryMap.getCenter(); setDeliveryPin(point.lat, point.lng); }
  };
  $('#set-delivery-coordinates').onclick = () => {
    const lat = $('#delivery-lat').value.trim(), lng = $('#delivery-lng').value.trim();
    if (!lat || !lng) return mapStatus('Enter both latitude and longitude.');
    setDeliveryPin(Number(lat), Number(lng));
  };
  $('#locate-delivery').onclick = () => {
    if (!navigator.geolocation) return mapStatus('Location is unavailable. Select a pin on the map instead.');
    mapStatus('Finding your location...');
    navigator.geolocation.getCurrentPosition(position => {
      if (!$('#delivery-map')) return;
      setDeliveryPin(position.coords.latitude, position.coords.longitude);
      if (deliveryMap) deliveryMap.setZoom(17);
    }, () => {
      if ($('#delivery-map-status')) mapStatus('Could not access your location. Allow location access or place a pin manually.');
    }, {enableHighAccuracy: true, timeout: 15000, maximumAge: 0});
  };
  function openDeliveryMap() {
    $('#delivery-picker').hidden = false;
    $('#open-delivery-map').setAttribute('aria-expanded', 'true');
    initializeDeliveryMap();
    $('#delivery-map').scrollIntoView({behavior: 'smooth', block: 'center'});
    $('#delivery-map').focus({preventScroll: true});
  }
  $('#open-delivery-map').onclick = openDeliveryMap;
  $('#method').onchange = () => {
    const delivery = $("#method").value === "delivery";

    $("#address").required = false;
    $('#address-field').hidden = !delivery;
    $('#delivery-map-action').hidden = !delivery;
    if (!delivery) {
      $('#delivery-picker').hidden = true;
      $('#open-delivery-map').setAttribute('aria-expanded', 'false');
    }

    $("#total").textContent =
      "Total " +
      money(subtotal() + (delivery ? deliveryFee : 0));
  };

  $("#checkout-form").onsubmit = async event => {
    event.preventDefault();
    const button = event.submitter;
    if ($('#method').value === 'delivery' && !deliveryLocation) {
      $('#checkout-error').textContent = 'Please select a delivery pin on the map.';
      openDeliveryMap();
      return;
    }
    button.disabled = true;

    try {
      const body = {
        ...Object.fromEntries(
          new FormData(event.target)
        ),
        items: bag,
        deliveryLocation: $('#method').value === 'delivery' ? deliveryLocation : null
      };

      const order = await api(
        "/orders",
        "POST",
        body
      );

      rememberOrder(order.id, order.token);
      bag = [];
      saveBag();
      await refreshProducts();

      location.hash =
        "#/order/" + order.id +
        "?token=" + order.token;
    } catch (error) {
      $("#checkout-error").textContent = error.message;
    } finally {
      if (button.isConnected) button.disabled = false;
    }
  };
}

function customCakePage(target = main) {
  target.innerHTML =
    '<section class="section">' +
      '<span class="eyebrow">Your occasion. Your cake.</span>' +
      '<h2>Let’s bake your idea.</h2>' +
      '<p>Tell us what you’re imagining. We’ll review your ' +
        'request before confirming a price or date.</p>' +
      '<form id="cake-form" class="panel">' +
        '<div class="fields">' +
          customerFields() +
          '<label>Size (kg)<select name="size">' +
            ['0.5 kg','1 kg','1.5 kg','2 kg','3 kg','4 kg','5 kg'].map(size => '<option' + (size === '1 kg' ? ' selected' : '') + '>' + size + '</option>').join('') +
          '</select></label>' +
          '<label>Flavour<select name="flavor">' +
            cakeMenu.map(group => '<optgroup label="' + escapeHTML(group.collection) + '">' +
              group.items.map(cake => '<option>' + escapeHTML(cake.name) + '</option>').join("") +
              '</optgroup>').join("") +
          '</select></label>' +
          '<label>Requested date' +
            '<input name="date" type="date" required ' +
              'min="' + minimumDate() + '"></label>' +
          '<label>Reference image<select id="cake-image-source"><option value="none">No image</option><option value="online">Online image link</option><option value="device" selected>Upload from device</option></select></label>' +
          '<label id="cake-image-online" hidden>Image URL<input name="reference_image" type="url" placeholder="https://example.com/cake.jpg" maxlength="2048" disabled></label>' +
          '<label id="cake-image-device">Choose image<input id="cake-image-file" type="file" accept="image/jpeg,image/png,image/webp"><small>JPG, PNG or WebP, up to 10 MB.</small></label>' +
          '<label class="wide">' +
            'Your idea, colours, message, and special requests' +
            '<textarea name="notes" required ' +
              'maxlength="2000"></textarea>' +
          '</label>' +
        '</div>' +
        '<p class="small">This is a request, not a confirmed ' +
          'booking. Allow at least 48 hours. Allergen-free ' +
          'production is not guaranteed.</p>' +
        '<p id="cake-error" class="error" role="alert"></p>' +
        '<button class="btn">Send your cake idea ↗</button>' +
      '</form>' +
    '</section>';

  $('#cake-image-source').onchange = event => {
    const source = event.target.value;
    $('#cake-image-online').hidden = source !== 'online';
    $('#cake-image-device').hidden = source !== 'device';
    $('#cake-image-online input').disabled = source !== 'online';
    $('#cake-image-file').disabled = source !== 'device';
  };

  $("#cake-form").onsubmit = async event => {
    event.preventDefault();
    const button = event.submitter;
    button.disabled = true;

    try {
      const values = Object.fromEntries(new FormData(event.target));
      if ($('#cake-image-source').value === 'device') {
        const file = $('#cake-image-file').files[0];
        values.reference_image = file ? await readAdminImage(file) : ''; 
      }
      const request = await api('/cakes', 'POST', values);

      target.innerHTML =
        '<section class="section">' +
          '<span class="eyebrow">A little inspiration, received</span>' +
          '<h1>Thank you, sweet thing.</h1>' +
          '<p>Your cake request reference is <strong>' +
            escapeHTML(request.id) +
            '</strong>. The bakery will review it.</p>' +
          '<a href="#/account?view=tracking" class="btn">Track your custom cake</a>' +
          '<a href="#/shop" class="btn">Back to the bakes</a>' +
        '</section>';
    } catch (error) {
      $("#cake-error").textContent = error.message;
      button.disabled = false;
    }
  };
}

function updateCustomerAccountLink(customer) {
  const host = $('#customer-account-menu');
  if (!customer) {
    host.innerHTML = '<a href="#/account" id="customer-account-link" class="btn secondary">Sign in</a>';
    return;
  }
  const view = new URLSearchParams(location.hash.split('?')[1] || '').get('view') || 'overview';
  const initials = customer.name.trim().split(/\s+/).filter(Boolean).slice(0,2).map(part => Array.from(part)[0]).join('').toUpperCase();
  const avatar = customer.profile_image && /^(https:\/\/|data:image\/(jpeg|png|webp);base64,)/.test(customer.profile_image) ? '<img src="' + escapeHTML(customer.profile_image) + '" alt="" onerror="this.hidden=true">' : '';
  host.innerHTML = '<details class="customer-account-dropdown"><summary id="customer-account-link" aria-label="' + escapeHTML(customer.name) + ', account navigation">' + '<span class="customer-avatar"><span aria-hidden="true">' + escapeHTML(initials) + '</span>' + avatar + '</span></summary><nav aria-label="Account navigation">' + [['overview','Overview'],['tracking','Track order'],['history','Order history'],['details','Account details']].map(([key,label]) => '<a href="#/account?view=' + key + '"' + (location.hash.startsWith('#/account') && view === key ? ' aria-current="page"' : '') + '>' + label + '</a>').join('') + '</nav></details>';
  const menu = host.querySelector('details');
  menu.onkeydown = event => { if(event.key === 'Escape') {menu.open = false; menu.querySelector('summary').focus();} };
  menu.onfocusout = event => {if (!menu.contains(event.relatedTarget)) menu.open = false;};
  menu.querySelectorAll('a').forEach(link => link.onclick = () => {menu.open = false;});
}
document.addEventListener('pointerdown', event => {
  const countryPicker = document.querySelector('.phone-country-dropdown');
  if (countryPicker && !countryPicker.contains(event.target)) countryPicker.open = false;
  const menu = document.querySelector('.customer-account-dropdown');
  if (menu && !menu.contains(event.target)) menu.open = false;
});
async function refreshCustomerAccountLink() {
  try { const account = await api('/customer/account'); updateCustomerAccountLink(account.customer); }
  catch { updateCustomerAccountLink(null); }
}

async function customerAccountPage(register = false) {
  let account;
  try { account = await api('/customer/account'); }
  catch(error) { if(error.message !== 'Sign in to view your account.') throw error; }
  updateCustomerAccountLink(account?.customer);
  if (!account) {
    main.innerHTML='<section class="section account-auth"><h1>'+ (register?'Create your account.':'Welcome back.') +'</h1><p>Sign in to view your account details, track orders, and see your history.</p><form id="account-auth-form" class="panel">'+(register?'<label>Name<input name="name" autocomplete="name" maxlength="100" required></label><label>ID number<input name="id_number" maxlength="8" autocomplete="off" required></label><p class="small">Maximum 8 characters.</p>':'')+'<label>Email<input name="email" type="email" autocomplete="email" maxlength="254" required></label><label>Password<input name="password" type="password" autocomplete="'+(register?'new-password':'current-password')+'" '+(register?'minlength="12"':'')+' maxlength="128" required></label><p id="account-error" class="error" role="alert"></p><button class="btn">'+(register?'Create account':'Sign in')+'</button></form><p>'+(register?'<a href="#/account">Already have an account? Sign in</a>':'<a href="#/register">Create an account</a>')+'</p></section>';
    $('#account-auth-form').onsubmit=async event=>{event.preventDefault();const button=event.submitter;button.disabled=true;try{await api('/customer/'+(register?'register':'login'),'POST',Object.fromEntries(new FormData(event.target)));if(register)location.hash='#/account';else await customerAccountPage();}catch(error){$('#account-error').textContent=error.message;}finally{if(button.isConnected)button.disabled=false;}};
    return;
  }
  const view=new URLSearchParams(location.hash.split('?')[1] || '').get('view') || 'overview';
  const {customer,orders,cakes = []}=account;
  main.innerHTML='<section class="section"><div class="row"><div><h1>'+escapeHTML(customer.name)+'</h1></div><button id="customer-signout" class="btn secondary">Sign out</button></div><div id="account-content"></div></section>';
  $('#customer-signout').onclick=async()=>{try{await api('/customer/logout','POST',{});await customerAccountPage();}catch(error){toast(error.message);}};
  const accountContent = $('#account-content');
  const accountLayout = document.createElement('div');
  accountLayout.className = 'customer-account-layout';
  accountContent.before(accountLayout);
  accountLayout.innerHTML = '<nav class="customer-account-sidebar" aria-label="Account sections">' + [['overview','Overview'],['tracking','Track order'],['history','Order history'],['details','Account details']].map(([key,label]) => '<a href="#/account?view=' + key + '"' + (view === key ? ' aria-current="page"' : '') + '>' + label + '</a>').join('') + '</nav>';
  accountLayout.appendChild(accountContent);
  const accountHeading = accountLayout.closest('section').querySelector(':scope > .row');
  accountHeading.classList.add('customer-sidebar-heading');
  accountLayout.querySelector('.customer-account-sidebar').prepend(accountHeading);
  accountLayout.querySelector('.customer-account-sidebar').appendChild($('#customer-signout'));
  const target=accountContent;
  if(view==='tracking') {
    const current=orders.filter(order=>!['completed','cancelled'].includes(order.status));
    target.innerHTML='<div class="row"><h2>Track your orders</h2><button type="button" class="btn secondary" id="refresh-account-orders">Refresh status</button></div>'+(current.length || !cakes.length ? customerOrderCards(current) : '')+customerCakeCards(cakes.filter(cake=>!['completed','cancelled','declined'].includes(cake.status)));
    $('#refresh-account-orders').onclick=()=>customerAccountPage().catch(error=>toast(error.message));
    return;
  }
  if(view==='history'){target.innerHTML='<h2>Order history</h2><p class="small">Buy again adds available items at current prices. Review quantities and dietary preferences in your bag before ordering.</p>'+(orders.length || !cakes.length ? customerOrderCards(orders,true) : '')+customerCakeCards(cakes);bindBuyAgain();return;}
  if(view !== 'details') {
    target.innerHTML = customerDashboard(orders,cakes);
    return;
  }
  target.innerHTML='<div class="panel"><h2>Account details</h2><p><strong>Name:</strong> '+escapeHTML(customer.name)+'</p><p><strong>Email:</strong> '+escapeHTML(customer.email)+'</p><p><strong>ID number:</strong> '+(customer.id_number?'Ending '+escapeHTML(customer.id_number.slice(-3)):'Not added')+'</p><a class="btn" href="#/account?view=tracking">Track my orders &rarr;</a></div>';
  target.insertAdjacentHTML('beforeend', '<form id="profile-photo-form" class="panel"><label>Profile picture<input type="file" id="profile-photo-file" accept="image/jpeg,image/png,image/webp"></label><p class="small">Choose a photo, then adjust the crop before saving. JPG, PNG or WebP up to 10 MB.</p><div id="profile-crop-editor" hidden><canvas id="profile-crop-preview" width="400" height="400" role="img" aria-label="Profile picture crop preview"></canvas><div class="profile-crop-controls"><label>Zoom<input id="profile-crop-zoom" type="range" min="1" max="3" step="0.01" value="1"></label><label>Horizontal position<input id="profile-crop-x" type="range" min="0" max="100" value="50"></label><label>Vertical position<input id="profile-crop-y" type="range" min="0" max="100" value="50"></label><button type="button" class="btn secondary" id="profile-crop-reset">Reset crop</button></div></div><p class="error" role="alert"></p><button id="profile-photo-save" class="btn" disabled>Save picture</button></form>');
  setupProfileCrop(customer.profile_image);
  target.insertAdjacentHTML('beforeend', '<form id="contact-preferences-form" class="panel"><h3>Contact preferences</h3><label>Phone number<div class="phone-country-fields"><details class="phone-country-dropdown"><summary id="phone-country-label">Choose country</summary><div class="phone-country-options"><input id="phone-country-search" type="search" placeholder="Search country or calling code" aria-label="Search phone countries" autocomplete="off"><select id="phone-country" aria-label="Phone country" hidden></select><div id="phone-country-list" aria-label="Countries"></div></div></details><span id="phone-country-code" aria-label="Country calling code">+254</span><input id="phone-national-number" type="tel" autocomplete="tel-national" maxlength="20" placeholder="712 345 678" aria-label="Phone number"></div></label><label>Preferred contact method<select name="preferred_contact">' + [['email','Email'],['whatsapp','WhatsApp'],['sms','SMS']].map(([value,label]) => '<option value="' + value + '"' + ((customer.preferred_contact || 'email') === value ? ' selected' : '') + '>' + label + '</option>').join('') + '</select></label><p class="error" role="alert"></p><button class="btn">Save contact preferences</button></form>');
  const detailsRow = document.createElement('div');
  detailsRow.className = 'customer-details-row';
  const detailsPanel = target.firstElementChild;
  target.insertBefore(detailsRow, detailsPanel);
  detailsRow.append(detailsPanel, $('#contact-preferences-form'), $('#profile-photo-form'));
  const phoneCountries = [
    ['KE','Kenya','254'],['UG','Uganda','256'],['TZ','Tanzania','255'],['RW','Rwanda','250'],['BI','Burundi','257'],['SS','South Sudan','211'],['ET','Ethiopia','251'],['SO','Somalia','252'],['SD','Sudan','249'],['CD','DR Congo','243'],['ZA','South Africa','27'],['NG','Nigeria','234'],['GH','Ghana','233'],['EG','Egypt','20'],['MA','Morocco','212'],['ZM','Zambia','260'],['ZW','Zimbabwe','263'],['MW','Malawi','265'],['MZ','Mozambique','258'],['BW','Botswana','267'],['NA','Namibia','264'],['CM','Cameroon','237'],['SN','Senegal','221'],['CI','C?te d?Ivoire','225'],['GB','United Kingdom','44'],['US','United States','1'],['CA','Canada','1'],['AE','United Arab Emirates','971'],['SA','Saudi Arabia','966'],['QA','Qatar','974'],['IN','India','91'],['PK','Pakistan','92'],['CN','China','86'],['JP','Japan','81'],['AU','Australia','61'],['NZ','New Zealand','64'],['DE','Germany','49'],['FR','France','33'],['IT','Italy','39'],['ES','Spain','34'],['NL','Netherlands','31'],['SE','Sweden','46'],['NO','Norway','47'],['CH','Switzerland','41'],['BR','Brazil','55'],['MX','Mexico','52']
  ];
  const countryFlag = code => '<img class="country-flag" src="https://flagcdn.com/w40/' + code.toLowerCase() + '.png" alt="" width="20" height="15">';
  const renderCountryList = () => {
    const select = $('#phone-country');
    const query = $('#phone-country-search').value.trim().toLowerCase();
    const numericQuery = query.replace(/^\+/, '');
    const searchingCode = /^\d+$/.test(numericQuery);
    $('#phone-country-list').innerHTML = Array.from(select.options).filter(option => !query || (searchingCode ? (option.dataset.dial || '').startsWith(numericQuery) : option.textContent.toLowerCase().includes(query) || option.value.toLowerCase().includes(query))).map(option => '<button type="button" data-country="' + option.value + '"' + (option.selected ? ' aria-current="true"' : '') + '>' + (option.value !== 'other' ? countryFlag(option.value) : '') + '<span>' + escapeHTML(option.textContent) + '</span></button>').join('');
    $('#phone-country-list').querySelectorAll('button').forEach(button => button.onclick = () => {select.value = button.dataset.country; select.onchange();});
  };
  const savedPhone = (customer.phone || '').replace(/[^+0-9]/g,'');
  const matched = savedPhone.startsWith('+') ? [...phoneCountries].sort((a,b)=>b[2].length-a[2].length).find(country=>savedPhone.startsWith('+'+country[2])) : null;
  $('#phone-country').innerHTML = phoneCountries.map(([code,name,dial])=>'<option value="' + code + '" data-dial="' + dial + '">' + name + ' (+' + dial + ')</option>').join('') + '<option value="other">Other country (enter full number)</option>';
  $('#phone-country').value = matched ? matched[0] : savedPhone.startsWith('+') ? 'other' : 'KE';
  $('#phone-national-number').value = matched ? savedPhone.slice(matched[2].length+1) : savedPhone;
  const updateDialCode = () => {
    const dial = $('#phone-country').selectedOptions[0].dataset.dial;
    $('#phone-country-label').innerHTML = ($('#phone-country').value !== 'other' ? countryFlag($('#phone-country').value) : '') + '<span>' + (dial ? '+' + dial : 'Code') + '</span><span aria-hidden="true">&#9662;</span>';
    $('#phone-country-label').setAttribute('aria-label', 'Choose country: ' + $('#phone-country').selectedOptions[0].textContent);
    renderCountryList();
    $('#phone-country-code').textContent = dial ? '+' + dial : '';
    $('#phone-country-code').hidden = !dial;
    $('#phone-national-number').placeholder = dial ? 'Phone number' : '+ country code and number';
  };
  $('#phone-country-search').oninput = event => {
    const query = event.target.value.trim().toLowerCase();
    const select = $('#phone-country');
    const selected = select.value;
    const numericQuery = query.replace(/^\+/, '');
    const searchingCode = /^\d+$/.test(numericQuery);
    const matches = phoneCountries.filter(([code,name,dial]) => searchingCode ? dial.startsWith(numericQuery) : (name + ' ' + code + ' +' + dial).toLowerCase().includes(query));
    if (searchingCode) matches.sort((a,b) => Number(a[2]) - Number(b[2]) || (a[0] === 'US' ? -1 : b[0] === 'US' ? 1 : a[1].localeCompare(b[1])));
    // Retain the saved selection while searching so typing never changes the phone code.
    const selectedCountry = phoneCountries.find(country => country[0] === selected);
    const options = selectedCountry && !matches.some(country=>country[0] === selected) ? [selectedCountry,...matches] : matches;
    select.innerHTML = options.map(([code,name,dial]) => '<option value="' + code + '" data-dial="' + dial + '">' + name + ' (+' + dial + ')</option>').join('') + '<option value="other">Other country (enter full number)</option>';
    select.value = selected;
    renderCountryList();
  };
  $('#phone-country').onchange = () => {
    updateDialCode();
    const dropdown = document.querySelector('.phone-country-dropdown');
    dropdown.open = false;
    dropdown.querySelector('summary').focus();
  };
  const countryDropdown = document.querySelector('.phone-country-dropdown');
  countryDropdown.ontoggle = () => { if(countryDropdown.open) $('#phone-country-search').focus(); };
  countryDropdown.onkeydown = event => { if(event.key === 'Escape') {countryDropdown.open = false; countryDropdown.querySelector('summary').focus();} };
  countryDropdown.onfocusout = event => { if(!countryDropdown.contains(event.relatedTarget)) countryDropdown.open = false; };
  updateDialCode();
  $('#contact-preferences-form').onsubmit = async event => {
    event.preventDefault(); const button = event.submitter; button.disabled = true;
    try {
      const values = Object.fromEntries(new FormData(event.target));
      const national = $('#phone-national-number').value.trim();
      const dial = $('#phone-country').selectedOptions[0].dataset.dial;
      values.phone = national ? (dial ? '+' + dial + national.replace(/\D/g,'').replace(/^0+/, '') : national) : '';
      await api('/customer/profile','PATCH',values); await customerAccountPage(); toast('Contact preferences saved.');
    }
    catch(error) {event.target.querySelector('.error').textContent = error.message; button.disabled = false;}
  };
  if(!customer.id_number){target.innerHTML+='<form id="complete-id" class="panel"><label>ID number<input name="id_number" maxlength="8" required></label><p class="small">Add up to 8 characters before ordering.</p><p class="error" id="id-error" role="alert"></p><button class="btn">Save ID number</button></form>';$('#complete-id').onsubmit=async event=>{event.preventDefault();try{await api('/customer/profile','PATCH',Object.fromEntries(new FormData(event.target)));await customerAccountPage();}catch(error){$('#id-error').textContent=error.message;}};}
}
function setupProfileCrop(currentImage) {
  const form = $('#profile-photo-form');
  const canvas = $('#profile-crop-preview');
  const context = canvas.getContext('2d');
  let photo = null, loading = 0;
  const controls = ['#profile-crop-zoom','#profile-crop-x','#profile-crop-y'];
  const draw = () => {
    if (!photo) return;
    const scale = Math.max(canvas.width / photo.naturalWidth, canvas.height / photo.naturalHeight) * Number($('#profile-crop-zoom').value);
    const width = photo.naturalWidth * scale, height = photo.naturalHeight * scale;
    const x = (canvas.width - width) * Number($('#profile-crop-x').value) / 100;
    const y = (canvas.height - height) * Number($('#profile-crop-y').value) / 100;
    context.clearRect(0,0,canvas.width,canvas.height);
    context.drawImage(photo,x,y,width,height);
  };
  const reset = () => { controls.forEach((selector,index) => $(selector).value = index === 0 ? '1' : '50'); draw(); };
  const load = async source => {
    const version = ++loading;
    $('#profile-photo-save').disabled = true;
    form.querySelector('.error').textContent = '';
    try {
      const next = new Image();
      next.src = source;
      await next.decode();
      if (version !== loading || !form.isConnected) return;
      photo = next;
      $('#profile-crop-editor').hidden = false;
      reset();
      $('#profile-photo-save').disabled = false;
    } catch { if(version === loading) form.querySelector('.error').textContent = 'Could not open this image. Choose another photo.'; }
  };
  controls.forEach(selector => $(selector).oninput = draw);
  $('#profile-crop-reset').onclick = reset;
  $('#profile-photo-file').onchange = async event => {
    const file = event.target.files[0];
    if (!file) return;
    try { await load(await readAdminImage(file)); }
    catch(error) {form.querySelector('.error').textContent = error.message; $('#profile-photo-save').disabled = true;}
  };
  if (currentImage) {
    const editor = document.createElement('div');
    editor.id = 'profile-photo-edit-fields';
    while (form.firstChild) editor.appendChild(form.firstChild);
    editor.hidden = true;
    form.appendChild(editor);
    const saved = document.createElement('div');
    saved.className = 'profile-photo-saved';
    saved.innerHTML = '<h3>Profile picture</h3><img src="' + escapeHTML(currentImage) + '" alt="Your saved profile picture" width="96" height="96"><button type="button" class="btn secondary" id="profile-photo-edit">Edit or change picture</button>';
    form.prepend(saved);
    $('#profile-photo-edit').onclick = () => {
      saved.hidden = true;
      editor.hidden = false;
      void load(currentImage);
      $('#profile-photo-file').focus();
    };
  }
  form.onsubmit = async event => {
    event.preventDefault();
    if (!photo) return;
    const button = event.submitter; button.disabled = true;
    try {
      const image = canvas.toDataURL('image/png');
      await api('/customer/profile','PATCH',{profile_image:image});
      await customerAccountPage();
      toast('Profile picture saved.');
    } catch(error) {form.querySelector('.error').textContent = error.message; button.disabled = false;}
  };
}

function customerDashboard(orders, cakes) {
  const active = item => !['completed','cancelled','declined'].includes(item.status);
  const all = [...orders.map(order => ({...order,kind:'Bakery order'})), ...cakes.map(cake => ({...cake,kind:'Custom cake',date:cake.details.date}))];
  const ongoing = all.filter(active);
  const recent = [...all].sort((a,b) => String(b.created).localeCompare(String(a.created))).slice(0,5);
  const upcoming = ongoing.filter(item => item.date).sort((a,b) => a.date.localeCompare(b.date))[0];
  const labels = {new:'Request received',reviewed:'Reviewed',contacted:'Design discussion',preparing:'Preparing',confirmed:'Confirmed',ready:'Ready',completed:'Completed',cancelled:'Cancelled',declined:'Declined','out for delivery':'Out for delivery'};
  const stats = [['Total orders & requests',all.length],['In progress',ongoing.length],['Custom cake requests',cakes.length],['Completed',all.filter(item=>item.status==='completed').length]];
  return '<div class="customer-dashboard"><div class="row"><h2>My account</h2><a class="text-link" href="#/shop">Browse the bakery &rarr;</a></div><div class="customer-summary">' + stats.map(([label,value])=>'<div class="panel"><span>' + label + '</span><strong>' + value + '</strong></div>').join('') + '</div>' + (upcoming ? '<div class="panel customer-next"><div><span class="eyebrow">Next scheduled</span><h3>' + escapeHTML(upcoming.kind) + ' &middot; ' + escapeHTML(upcoming.date) + '</h3><p>' + escapeHTML(upcoming.id) + ' &middot; ' + escapeHTML(labels[upcoming.status] || upcoming.status) + '</p></div><a class="btn secondary" href="#/account?view=tracking">Track progress</a></div>' : '') + '<div class="panel"><div class="row"><h3>Recent activity</h3><a class="text-link" href="#/account?view=history">View all history &rarr;</a></div>' + (recent.length ? '<ul class="customer-activity">' + recent.map(item=>'<li><div><strong>' + escapeHTML(item.kind) + '</strong><small>' + escapeHTML(item.id) + ' &middot; Requested for ' + escapeHTML(item.date) + '</small></div><span class="badge">' + escapeHTML(labels[item.status] || item.status) + '</span></li>').join('') + '</ul>' : '<p>No orders yet. Explore our bakes or share an idea for a custom cake.</p><a class="btn" href="#/shop">Shop the bakes</a> <a class="btn secondary" href="#/custom">Create a custom cake</a>') + '</div></div>';
}

function customerCakeCards(cakes) {
  if (!cakes.length) return '';
  const steps = ['new','reviewed','contacted','confirmed','preparing','ready','completed'];
  const labels = {new:'Request received',reviewed:'Reviewed',contacted:'Design discussion',confirmed:'Confirmed',preparing:'Baking & decorating',ready:'Ready',completed:'Completed'};
  return '<h2>Custom cakes</h2>' + cakes.map(cake => '<article class="panel"><div class="row"><h3>' + escapeHTML(cake.id) + '</h3><span class="badge">' + escapeHTML(labels[cake.status] || cake.status) + '</span></div><p>' + escapeHTML(cake.details.flavor) + ' &middot; ' + escapeHTML(cake.details.size) + '<br>Requested date: ' + escapeHTML(cake.details.date) + '</p>' + (['cancelled','declined'].includes(cake.status) ? '<p>This request is ' + escapeHTML(cake.status) + '. Contact the bakery with any questions.</p>' : '<ol class="order-progress" aria-label="Custom cake progress">' + steps.map((step,index)=>'<li class="' + (index <= steps.indexOf(cake.status) ? 'reached' : '') + '"' + (step === cake.status ? ' aria-current="step"' : '') + '><span>' + (index+1) + '</span>' + labels[step] + '</li>').join('') + '</ol>') + '<details><summary>Your requirements</summary><p style="white-space:pre-wrap">' + escapeHTML(cake.details.notes) + '</p>' + (cake.details.reference_image ? '<img src="' + escapeHTML(cake.details.reference_image) + '" alt="Your cake reference" style="width:200px;max-width:100%;max-height:200px;object-fit:contain" loading="lazy">' : '') + '</details></article>').join('');
}

function customerOrderCards(orders, allowReorder = false) {
  return orders.length ? orders.map(order=>'<article class="panel"><div class="row"><h3>'+escapeHTML(order.id)+'</h3><span class="badge">'+escapeHTML(order.status)+'</span></div><p>'+escapeHTML(order.date)+' &middot; '+escapeHTML(order.method)+' &middot; '+money(order.total)+'</p>'+orderProgress(order)+'<a class="btn secondary" href="#/order/'+encodeURIComponent(order.id)+'">View order details</a>'+(allowReorder && order.status !== 'cancelled' ? '<button type="button" class="btn secondary buy-again" data-buy-again="'+escapeHTML(order.id)+'">Buy again</button>' : '')+'</article>').join('') : '<p>No orders here yet. <a href="#/shop">Browse the bakery</a>.</p>';
}

function bindBuyAgain() {
  document.querySelectorAll('[data-buy-again]').forEach(button=>{
    button.onclick=async()=>{button.disabled=true;try {await buyAgain(button.dataset.buyAgain);}catch(error){toast(error.message);}finally{if(button.isConnected)button.disabled=false;}};
  });
}
async function buyAgain(orderId) {
  const account = await api('/customer/account');
  const order = account.orders.find(order=>order.id === orderId);
  if (!order || order.status === 'cancelled') throw Error('This order is unavailable for reordering.');
  await refreshProducts();
  let added = 0, limited = false;
  for (const item of order.items) {
    const product = products.find(product=>product.id===item.id);
    const existing = bag.find(line=>line.id===item.id);
    const available = product ? Math.max(0,Math.min(product.stock,50)-(existing?.quantity || 0)) : 0;
    const quantity = Math.min(available,Number.isSafeInteger(item.quantity) ? item.quantity : 0);
    if (quantity < item.quantity) limited = true;
    if (!quantity) continue;
    if (existing) existing.quantity += quantity;
    else bag.push({id:item.id,quantity,excluded:Array.isArray(item.excluded)?item.excluded:[],notes:typeof item.notes==='string'?item.notes:''});
    added += quantity;
  }
  if (!added) {toast('These items are currently unavailable or already at the stock limit in your bag.');return;}
  saveBag();openBag();
  toast(added+' item'+(added===1?'':'s')+' added at current prices.'+(limited?' Some quantities were unavailable.':'')+' Review your preferences before checkout.');
}

function rememberedOrders() {
  try {
    const saved = JSON.parse(localStorage.getItem('subanese-tracking') || '[]');
    return Array.isArray(saved) ? saved.filter(order => /^SUB-[A-F0-9]{10}$/.test(order.id) && /^[a-f0-9]{36}$/.test(order.token)).slice(0, 5) : [];
  } catch { return []; }
}

function rememberOrder(id, token) {
  try {
    const orders = [{id, token}, ...rememberedOrders().filter(order => order.id !== id)].slice(0, 5);
    localStorage.setItem('subanese-tracking', JSON.stringify(orders));
  } catch { /* Tracking links still work when browser storage is unavailable. */ }
}

function trackOrderPage(target = main) {
  target.innerHTML = '<section class="section"><span class="eyebrow">Follow your treats</span>' +
    '<h2>Track your order.</h2><p>Paste the private tracking link from your order confirmation or email to see its latest progress.</p>' +
    '<form id="track-order-form" class="panel"><label>Private tracking link<input name="link" type="text" required placeholder="Paste your order tracking link" autocomplete="off"></label>' +
    '<p id="track-order-error" class="error" role="alert"></p><button class="btn">Track order</button></form>' +
    '<h2>Orders saved on this device</h2>' +
    (rememberedOrders().map(order => '<div class="panel row"><strong>' + escapeHTML(order.id) + '</strong><a class="btn secondary" href="#/order/' + encodeURIComponent(order.id) + '?token=' + encodeURIComponent(order.token) + '">View progress</a></div>').join('') || '<p>No orders saved on this device yet.</p>') +
    '<p class="small">Keep tracking links private. Anyone with the link can view the order summary.</p></section>';
  $('#track-order-form').onsubmit = event => {
    event.preventDefault();
    const value = event.target.elements.link.value.trim();
    try {
      const hash = value.startsWith('#') ? value : new URL(value, location.href).hash;
      const match = /^#\/order\/(SUB-[A-F0-9]{10})\?/.exec(hash);
      const token = new URLSearchParams(hash.split('?')[1] || '').get('token');
      if (!match || !/^[a-f0-9]{36}$/.test(token || '')) throw Error('Paste a complete private tracking link, including its token.');
      location.hash = '#/order/' + match[1] + '?token=' + token;
    } catch (error) { $('#track-order-error').textContent = 'Paste a complete private tracking link from your order confirmation.'; }
  };
}

function orderProgress(order) {
  if (order.status === 'cancelled') return '<p class="notice">This order has been cancelled. Contact the bakery with any questions.</p>';
  const steps = ['confirmed', 'preparing', order.method === 'pickup' ? 'ready' : 'out for delivery', 'completed'];
  const current = steps.indexOf(order.status);
  const labels = {confirmed: 'Confirmed', preparing: 'Preparing', ready: 'Ready for pickup', 'out for delivery': 'Out for delivery', completed: 'Completed'};
  return '<ol class="order-progress" aria-label="Order progress">' + steps.map((step, index) =>
    '<li' + (index === current ? ' aria-current="step"' : '') + ' class="' + (index <= current ? 'reached' : '') + '"><span>' + (index + 1) + '</span>' + labels[step] + '</li>'
  ).join('') + '</ol>';
}

async function orderPage() {
  try { await api('/customer/account'); }
  catch(error) { if(error.message === 'Sign in to view your account.') { location.hash='#/account'; return; } throw error; }

  const [pathname, query] =
    location.hash.slice(2).split("?");

  const id = pathname.split("/")[1];
  const token = new URLSearchParams(query).get("token");

  const order = await api(
    "/orders/" + encodeURIComponent(id) +
    "?token=" + encodeURIComponent(token)
  );
  if (token) rememberOrder(order.id, token);

  main.innerHTML =
    '<section class="section">' +
      '<span class="eyebrow">A lovely choice</span>' +
      '<h1>Your order details.</h1>' +
      '<div class="panel">' +
        '<h3>' + escapeHTML(order.id) + '</h3>' +
        '<span class="badge">' +
          escapeHTML(order.status) +
        '</span>' +
        orderProgress(order) +
        '<p>' + escapeHTML(order.method) +
          ' · ' + escapeHTML(order.date) + '</p>' +
        order.items.map(item =>
          '<div class="line">' +
            escapeHTML(item.name) +
            ' × ' + item.quantity +
            ' · ' + money(item.price * item.quantity) + preferenceSummary(item) +
          '</div>'
        ).join("") +
        '<h3>Total ' + money(order.total) + '</h3>' +
        (order.method === 'delivery' ? '<p>' + escapeHTML(order.address) + '</p>' + deliveryLink(order.deliveryLocation) : '') +
        '<p class="small">Only you can view this order while signed in.</p><p><a href="#/account?view=tracking">Back to my orders</a></p>' +
        '<button id="refresh-order" class="btn secondary">' +
          'Refresh status</button>' +
      '</div>' +
    '</section>';

  $("#refresh-order").onclick = () =>
    orderPage().catch(error => toast(error.message));
}

function adminItemCards() {
  const categories = [...new Set([...bakeryCategories.map(category => category.name), ...products.map(product => product.category)])];
  return products.map(product => '<article class="panel"><h3>' + escapeHTML(product.name) + '</h3>' +
    photoImage(productPhoto(product), 'admin-product-photo') +
    '<p>' + escapeHTML(product.category) + ' &middot; ' + money(product.price) + ' &middot; Stock: ' + product.stock + '</p>' +
    '<details><summary>Edit item</summary><form data-edit-product="' + product.id + '">' +
    '<label>Name<input name="name" maxlength="100" required value="' + escapeHTML(product.name) + '"></label>' +
    '<label>Category<select name="category">' + categories.map(category => '<option' + (category === product.category ? ' selected' : '') + '>' + escapeHTML(category) + '</option>').join('') + '</select></label>' +
    '<label>Replace image<input name="image_file" type="file" accept="image/jpeg,image/png,image/webp"></label>' +
    '<p class="small">JPG, PNG or WebP up to 10 MB. Leave unchanged to keep the current image.</p>' +
    '<label>Ingredients<textarea name="ingredients" maxlength="5000">' + escapeHTML(product.ingredients || '') + '</textarea></label>' +
    '<label>Allergens<textarea name="allergens" maxlength="1000">' + escapeHTML(product.allergens || '') + '</textarea></label>' +
    '<div class="fields"><label>Price<input name="price" type="number" min="1" max="1000000" step="1" required value="' + product.price + '"></label>' +
    '<label>Stock<input name="stock" type="number" min="0" max="10000" step="1" required value="' + product.stock + '"></label></div>' +
    '<button class="btn" style="margin-top:16px">Save changes</button></form></details>' +
    '<button type="button" class="btn secondary" style="margin-top:16px" data-delete-product="' + product.id + '">Delete item</button></article>').join('');
}

async function readAdminImage(file, fallback = '') {
  if (!file) return fallback;
  if (file.size > 10 * 1024 * 1024 || !['image/jpeg','image/png','image/webp'].includes(file.type)) throw Error('Choose a JPG, PNG or WebP up to 10 MB.');
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(Error('Could not read image.'));
    reader.readAsDataURL(file);
  });
}

async function financePage() {
  const data = await api('/admin/finance');
  const host = $('#finance-content');
  const fmt = value => new Intl.NumberFormat('en', {style:'currency',currency:data.currency}).format(value/100);
  const metric = (label,value,note,tone='') => '<article class="finance-metric '+tone+'"><p>'+label+'</p><strong>'+value+'</strong><span>'+note+'</span></article>';
  host.innerHTML = '<div class="finance-heading"><div><span class="eyebrow">Subanese / financial records</span><h2>Finance &amp; inventory</h2><p>A clear view of collections, costs, and bakery operations.</p></div><a class="btn secondary" href="#/admin?view=dashboard">View analytics &nearr;</a></div><div class="finance-context"><span><i></i>All-time overview</span><span>'+escapeHTML(data.currency)+' &middot; Manual payment records</span></div><div class="finance-metrics">'+
    metric('Order value',fmt(data.summary.sales),'Excludes cancelled orders')+
    metric('Received payments',fmt(data.summary.received),'Manually confirmed receipts','positive')+
    metric('Outstanding value',fmt(data.summary.outstanding),'Orders not fully covered','attention')+
    metric('Refunds',fmt(data.summary.refunded),'Linked to received payments')+
    metric('Expenses, net',fmt(data.summary.expenses),'Includes recorded corrections')+
    metric('Cash surplus',fmt(data.summary.cashSurplus),'Collections less refunds & expenses','highlight')+
    metric('Production costs',fmt(data.summary.productionCost),'Ingredient & packaging costs')+metric('Waste cost',fmt(data.summary.wasteCost),'Recorded product losses')+metric('Repeat customers',data.analysis.repeatCustomers,'Accounts with multiple orders')+'</div><details class="finance-explainer"><summary>How to read these figures</summary><p>Cash surplus is not accounting profit. Production and waste costs are shown separately and are not deducted twice. Payment records are manual confirmations; reconcile them against cash, M-Pesa, bank, or card statements.</p><p>Historical breakdowns may be labelled legacy-derived. Records here do not initiate payments or refunds. CSV amounts are stored in minor currency units (100 = 1 currency unit).</p></details>' +
    '<details class="panel"><summary>Sales &amp; product analysis</summary><h3>Daily sales (Nairobi)</h3><div class="table"><table><thead><tr><th>Date</th><th>Orders</th><th>Order value</th></tr></thead><tbody>'+data.analysis.dailySales.map(row=>'<tr><td>'+escapeHTML(row.date)+'</td><td>'+row.orders+'</td><td>'+fmt(row.sales_minor)+'</td></tr>').join('')+'</tbody></table></div><h3>Products</h3><div class="table"><table><thead><tr><th>Product</th><th>Quantity sold</th><th>Item value</th></tr></thead><tbody>'+data.analysis.products.map(row=>'<tr><td>'+escapeHTML(row.name)+'</td><td>'+row.quantity+'</td><td>'+fmt(row.sales_minor)+'</td></tr>').join('')+'</tbody></table></div></details><div class="panel finance-entry"><h3>Add a record</h3><p class="finance-section-copy">Record a payment, purchase, production batch, or stock loss.</p><label>Record type<select id="finance-kind">'+[['payments','Payment'],['payment-events','Confirm pending payment'],['refunds','Refund'],['expenses','Expense / purchase'],['expense-reversals','Reverse an expense'],['batches','Production batch (adds stock)'],['waste','Waste (removes stock)']].map(([value,label])=>'<option value="'+value+'">'+label+'</option>').join('')+'</select></label><form id="finance-form"><div id="finance-fields" class="fields"></div><p id="finance-error" class="error" role="alert"></p><button class="btn">Save record</button></form></div><section class="finance-records"><h3>Records &amp; CSV exports</h3><p class="finance-section-copy">Review your ledger or download a complete dataset.</p><label>Dataset<select id="finance-dataset">'+Object.keys(data.records).map(key=>'<option>'+key+'</option>').join('')+'</select></label><p><a class="btn secondary" id="finance-export">Download CSV</a></p><div id="finance-table" class="table" tabindex="0" role="region" aria-label="Financial records"></div></section>';
  const input = (name,label,type='text',extra='') => '<label>'+label+'<input name="'+name+'" type="'+type+'" required '+extra+'></label>';
  const choice = (name,label,values) => '<label>'+label+'<select name="'+name+'">'+values.map(([value,text])=>'<option value="'+escapeHTML(value)+'">'+escapeHTML(text)+'</option>').join('')+'</select></label>';
  const amount = (name,label,zero=false) => input(name,label+' ('+data.currency+')','number','step="0.01" min="'+(zero?'0':'0.01')+'" max="1000000000"');
  const today = new Intl.DateTimeFormat('en-CA',{timeZone:'Africa/Nairobi',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  const reference = () => input('reference','Unique transaction / receipt reference');
  const product = () => choice('product_id','Product',products.map(p=>[p.id,p.name]));
  const forms = {
    payments:()=>input('order_id','Order reference')+amount('amount_minor','Amount')+choice('method','Payment method',[['mpesa','M-Pesa'],['cash','Cash'],['bank','Bank'],['card','Card']])+choice('status','Recorded status',[['pending','Pending'],['succeeded','Received (manual confirmation)'],['failed','Failed']])+reference(),
    'payment-events':()=>choice('payment_id','Pending payment',data.records.payments.filter(p=>p.status==='pending').map(p=>[p.id,p.reference+' / '+fmt(p.amount_minor)]))+choice('status','Confirmation',[['succeeded','Received'],['failed','Failed']])+reference(),
    refunds:()=>choice('payment_id','Received payment',data.records.payments.filter(p=>p.status==='succeeded').map(p=>[p.id,p.order_id+' / '+p.reference+' / '+fmt(p.amount_minor)]))+amount('amount_minor','Refund amount')+reference()+input('reason','Refund reason'),
    expenses:()=>amount('amount_minor','Amount')+choice('category','Category',data.categories.map(c=>[c,c]))+input('supplier','Supplier / payee')+reference()+input('note','Description'),
    'expense-reversals':()=>choice('expense_id','Original expense',data.records.expenses.filter(e=>!e.reverse_of&&!data.records.expenses.some(r=>r.reverse_of===e.id)).map(e=>[e.id,e.reference+' / '+fmt(e.amount_minor)]))+reference()+input('reason','Correction reason'),
    batches:()=>product()+input('batch','Unique batch reference')+input('quantity','Quantity produced','number','min="1" max="10000" step="1"')+amount('ingredient_minor','Total ingredient cost',true)+amount('packaging_minor','Total packaging cost',true),
    waste:()=>product()+choice('batch_id','Batch (optional)',[['','No batch'],...data.records.batches.map(b=>[b.id,b.batch])])+input('quantity','Quantity wasted','number','min="1" max="10000" step="1"')+amount('cost_minor','Total waste cost',true)+reference()+input('reason','Waste reason')
  };
  const drawForm=()=>{$('#finance-fields').innerHTML=forms[$('#finance-kind').value]()+input('date','Record date','date','value="'+today+'" max="'+today+'"');$('#finance-error').textContent='';};
  $('#finance-kind').onchange=drawForm;
  const requestedRecord=new URLSearchParams(location.hash.split('?')[1]||'').get('record');
  if(forms[requestedRecord]) $('#finance-kind').value=requestedRecord;
  drawForm();
  const requestedOrder=new URLSearchParams(location.hash.split('?')[1]||'').get('order');
  const orderInput=$('#finance-fields input[name="order_id"]');
  if(requestedOrder && orderInput)orderInput.value=requestedOrder;
  if(requestedRecord){$('#finance-kind').scrollIntoView({block:'center'});$('#finance-kind').focus({preventScroll:true});}

  $('#finance-form').onsubmit=async event=>{
    event.preventDefault();const button=event.submitter;button.disabled=true;
    try {
      const body=Object.fromEntries(new FormData(event.target));
      for(const key of ['amount_minor','ingredient_minor','packaging_minor','cost_minor'])if(body[key]!==undefined){if(!/^[0-9]+(?:[.][0-9]{1,2})?$/.test(body[key]))throw Error('Use at most two decimal places for costs.');const parts=body[key].split('.');body[key]=Number(parts[0])*100+Number((parts[1]||'').padEnd(2,'0'));}
      for(const key of ['product_id','quantity'])if(body[key]!==undefined)body[key]=Number(body[key]);
      await api('/admin/finance/'+$('#finance-kind').value,'POST',body);await refreshProducts();await financePage();toast('Finance record saved.');
    }catch(error){$('#finance-error').textContent=error.message;}finally{if(button.isConnected)button.disabled=false;}
  };
  const drawRecords=()=>{
    const kind=$('#finance-dataset').value,rows=data.records[kind],columns=rows.length?Object.keys(rows[0]):[];
    $('#finance-export').href='/api/admin/finance/export?type='+encodeURIComponent(kind);
    $('#finance-table').innerHTML=rows.length?'<p class="small">Showing the latest '+Math.min(rows.length,100)+' of '+rows.length+' records. CSV includes all rows. Fields ending in _minor are minor currency units.</p><table><thead><tr>'+columns.map(c=>'<th>'+escapeHTML(c)+'</th>').join('')+'</tr></thead><tbody>'+rows.slice(-100).reverse().map(row=>'<tr>'+columns.map(c=>'<td>'+escapeHTML(row[c])+'</td>').join('')+'</tr>').join('')+'</tbody></table>':'<p>No records yet.</p>';
  };
  $('#finance-dataset').onchange=drawRecords;drawRecords();
}

function adminKpi(label, value, note = '') {
  return '<article class="panel kpi-card"><p>' + label + '</p><strong>' + value + '</strong><small>' + note + '</small></article>';
}
function transactionCsv(rows) {
  const cell = value => {
    let text = String(value ?? '');
    if (/^[\s]*[=+@\-]/.test(text) || /^[\t\r\n]/.test(text)) text = "'" + text;
    return '"' + text.replace(/"/g, '""') + '"';
  };
  const columns = ['Order reference','Created (UTC)','Created (Nairobi)','Customer','Fulfillment','Order status','Amount','Currency'];
  const data = rows.map(order => [order.id,order.created,new Date(order.created).toLocaleString('en-GB',{timeZone:'Africa/Nairobi'}),order.name,order.method,order.status,order.total,currency]);
  return '\uFEFF' + [columns,...data].map(row=>row.map(cell).join(',')).join('\r\n');
}
function downloadTransactions(rows) {
  const url = URL.createObjectURL(new Blob([transactionCsv(rows)],{type:'text/csv;charset=utf-8;'}));
  const link = document.createElement('a');
  link.href=url;link.download='subanese-transactions-'+new Date().toISOString().slice(0,10)+'.csv';
  document.body.appendChild(link);link.click();link.remove();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
}

function orderPaymentSummary(order, finance) {
  const received = (finance?.records?.payments || []).filter(payment => payment.order_id === order.id && payment.status === 'succeeded').reduce((sum, payment) => sum + payment.amount_minor, 0);
  const balance = Math.max(0, Math.round(order.total * 100) - received);
  return {received, balance, label: balance === 0 ? 'Paid in full' : received > 0 ? 'Partially paid' : 'Unpaid'};
}
function orderPaymentSection(order, finance) {
  const payment = orderPaymentSummary(order, finance);
  const today = new Intl.DateTimeFormat('en-CA', {timeZone:'Africa/Nairobi',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  return '<strong>' + payment.label + '</strong><p class="small">Received: ' + money(payment.received / 100) + '<br>Balance: ' + money(payment.balance / 100) + '</p>' +
    (payment.balance && order.status !== 'cancelled' ? '<details><summary>Record payment received</summary><form data-order-payment="' + escapeHTML(order.id) + '"><label>Payment received<select name="coverage"><option value="full">Full remaining balance</option><option value="partial">Partial payment</option></select></label><label hidden>Amount received (' + escapeHTML(currency) + ')<input name="amount" type="number" min="0.01" step="0.01" max="' + (payment.balance / 100) + '"></label><label>Method<select name="method"><option value="mpesa">M-Pesa</option><option value="cash">Cash</option><option value="card">Card</option><option value="bank">Bank</option></select></label><label>Payment reference<input name="reference" required maxlength="200"></label><label>Date received<input name="date" type="date" required value="' + today + '" max="' + today + '"></label><p class="error" role="alert"></p><button class="btn" type="submit">Save received payment</button></form></details>' : '');
}
function adminTransactions(rows) {
  const amount = rows.filter(order => order.status !== 'cancelled').reduce((sum, order) => sum + order.total, 0);
  return '<div class="admin-stats transaction-stats">' + adminKpi('Transactions', rows.length) + adminKpi('Order value', money(amount), 'Excludes cancellations') + '</div><div class="table" tabindex="0" role="region" aria-label="Transactions"><table><thead><tr><th>Reference</th><th>Created (Nairobi)</th><th>Customer</th><th>Fulfillment</th><th>Status</th><th>Amount</th></tr></thead><tbody>' +
    (rows.length ? rows.map(order => '<tr><td>' + escapeHTML(order.id) + '</td><td>' + escapeHTML(new Date(order.created).toLocaleString('en-GB', {timeZone:'Africa/Nairobi'})) + '</td><td>' + escapeHTML(order.name) + '</td><td>' + escapeHTML(order.method) + '</td><td>' + escapeHTML(order.status) + '</td><td>' + money(order.total) + '</td></tr>').join('') : '<tr><td colspan="6">No transactions found.</td></tr>') + '</tbody></table></div>';
}
document.addEventListener('pointerdown', event => {
  const menu = $('#admin-profile-menu'), profile = $('#admin-profile');
  if (menu && !menu.contains(event.target)) { menu.open = false; if (profile && !profile.contains(event.target)) profile.hidden = true; }
});

async function adminPage() {
  let data;

  try {
    const requestedOrder = new URLSearchParams(location.hash.split('?')[1] || '').get('order');
    data = await api('/admin' + (requestedOrder ? '?order=' + encodeURIComponent(requestedOrder) : ''));
  } catch {
    main.innerHTML =
      '<section class="admin-auth section" aria-labelledby="admin-login-title">' +
        '<div class="admin-auth-background" aria-hidden="true"><video id="admin-event-video" muted loop playsinline preload="none" poster="/media/admin-event.jpg"><source src="/media/admin-event.mp4" type="video/mp4" media="(max-width: 900px)"><source src="/media/admin-event-4k.mp4" type="video/mp4"><source src="/media/admin-event.mp4" type="video/mp4"></video></div>' +
        '<div class="admin-auth-media-controls"><button id="admin-event-toggle" type="button" aria-controls="admin-event-video">Play background video</button><a href="https://www.pexels.com/video/a-woman-serving-the-birthday-cake-10033145/" target="_blank" rel="noopener noreferrer">Video by Ron Lach / Pexels &nearr;</a></div>' +
        '<a class="admin-auth-back" href="/#/shop">&larr; Back to storefront</a>' +
        '<div class="admin-auth-card"><div class="admin-auth-intro">' +
          '<a class="brand site-brand" href="/#/" aria-label="Subanese home"><span class="brand-logo"><img src="/brand/logo.jpeg" alt="" width="80" height="80"></span><span class="brand-wordmark">Subanese<small>WE BAKE, YOU TAKE</small></span></a>' +
          '<span class="eyebrow">Behind the bakes</span><h1>The bakery desk.</h1>' +
          '<p>A little organization for every sweet celebration.</p>' +
          '<ul><li>Keep orders moving</li><li>Manage your menu and stock</li><li>Stay on top of bakery performance</li></ul>' +
        '</div><div class="admin-auth-form">' +
        '<span class="eyebrow">Administrator access</span><h2 id="admin-login-title">Welcome back</h2>' +
        '<p>Enter your administrator password to open your workspace.</p>' +
        '<form id="login">' +
          '<label for="admin-password">Administrator password</label>' +
          '<div class="admin-password-field"><input id="admin-password" type="password" name="password" required autocomplete="current-password" aria-describedby="login-help login-error" autocapitalize="none" spellcheck="false"><button id="admin-password-toggle" type="button" aria-controls="admin-password" aria-pressed="false">Show</button></div>' +
          '<p id="admin-caps-lock" class="small" hidden>Caps Lock is on.</p>' +
          '<p id="login-error" class="error" role="alert"></p>' +
          '<button id="admin-sign-in" class="btn" type="submit">Sign in to admin</button>' +
          '<p id="login-help" class="small">Need access? Contact the person who manages your bakery account.</p>' +
        '</form></div></div>' +
      '</section>';

    const backgroundVideo = $('#admin-event-video');
    const backgroundToggle = $('#admin-event-toggle');
    backgroundVideo.muted = true;
    backgroundVideo.onplay = () => { backgroundToggle.textContent = 'Pause background video'; };
    backgroundVideo.onpause = () => { backgroundToggle.textContent = 'Play background video'; };
    backgroundVideo.onerror = () => { backgroundToggle.hidden = true; };
    backgroundToggle.onclick = () => {
      if (backgroundVideo.paused) void backgroundVideo.play().catch(() => { backgroundToggle.textContent = 'Play background video'; });
      else backgroundVideo.pause();
    };
    if (!matchMedia('(prefers-reduced-motion: reduce)').matches && !navigator.connection?.saveData) {
      void backgroundVideo.play().catch(() => {});
    }
    const passwordInput = $('#admin-password');
    $('#admin-password-toggle').onclick = event => {
      const show = passwordInput.type === 'password';
      passwordInput.type = show ? 'text' : 'password';
      event.currentTarget.textContent = show ? 'Hide' : 'Show';
      event.currentTarget.setAttribute('aria-pressed', String(show));
    };
    const showCapsLock = event => { $('#admin-caps-lock').hidden = !event.getModifierState('CapsLock'); };
    passwordInput.addEventListener('keydown', showCapsLock);
    passwordInput.addEventListener('keyup', showCapsLock);
    passwordInput.oninput = () => { passwordInput.removeAttribute('aria-invalid'); $('#login-error').textContent = ''; };
    $("#login").onsubmit = async event => {
      event.preventDefault();
      const form = event.currentTarget;
      const button = $('#admin-sign-in');
      if (button.disabled) return;
      button.disabled = true;
      button.textContent = 'Signing in…';
      form.setAttribute('aria-busy', 'true');
      $('#login-error').textContent = '';
      try {
        await api(
          "/login",
          "POST",
          Object.fromEntries(
            new FormData(event.target)
          )
        );

        await adminPage();
      } catch (error) {
        $("#login-error").textContent = error.message;
        passwordInput.setAttribute('aria-invalid', 'true');
        passwordInput.focus();
      } finally {
        if (form.isConnected) {
          button.disabled = false;
          button.textContent = 'Sign in to admin';
          form.removeAttribute('aria-busy');
        }
      }
    };

    return;
  }

  function nextStatuses(order) {
    return ({
      confirmed: ["preparing", "cancelled"],
      preparing: [
        order.method === "pickup"
          ? "ready"
          : "out for delivery"
      ],
      ready: ["completed"],
      "out for delivery": ["completed"]
    })[order.status] || [];
  }

  const requestedView = new URLSearchParams(location.hash.split('?')[1] || '').get('view') || 'home';
  const view = ['home', 'dashboard', 'orders', 'cakes', 'transactions', 'finance', 'items'].includes(requestedView) ? requestedView : 'home';
  const activeOrders = data.orders.filter(order => !['completed', 'cancelled'].includes(order.status)).length;
  main.innerHTML =
    '<div class="admin-layout"><aside class="admin-sidebar">' +
      '<a class="brand site-brand admin-brand" href="#/admin?view=home" aria-label="Subanese administration"><span class="brand-logo"><img src="/brand/logo.jpeg" alt="" width="80" height="80"></span><span class="brand-wordmark">Subanese<small>WE BAKE, YOU TAKE</small></span></a><p class="eyebrow">Administration</p>' +
      '<nav aria-label="Admin navigation">' +
      [['home','Home'],['dashboard','Analytics'],['orders','Orders'],['cakes','Custom cakes'],['transactions','Transactions'],['finance','Finance'],['items','Items'],['storefront','Storefront']].map(([key,label]) =>
        (key === 'storefront'
          ? '<a href="/#/shop" target="_blank" rel="noopener noreferrer" aria-label="Storefront (opens in a new tab)">' + label + ' &nearr;</a>'
          : '<a href="#/admin?view=' + key + '"' + (view === key ? ' aria-current="page"' : '') + '>' + label + '</a>')
      ).join('') + '</nav><a class="admin-store-link" href="/#/shop" target="_blank" rel="noopener noreferrer">View storefront &nearr;</a></aside>' +
      '<section class="admin-content section">' +
      '<div class="admin-toolbar"><strong class="admin-page-title">' + escapeHTML({home:'Home',dashboard:'Analytics',orders:'Orders',cakes:'Custom cakes',transactions:'Transactions',finance:'Finance',items:'Items'}[view]) + '</strong><button type="button" class="theme-toggle" data-theme-toggle aria-label="Switch color theme"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M20.9 13A9 9 0 0 1 11 3.1 9 9 0 1 0 20.9 13Z"/></svg></button><details id="admin-profile-menu" class="profile-menu"><summary aria-label="Open admin profile"><span class="admin-display-name">' + escapeHTML(data.profile.name || data.profile.username) + '</span><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/></svg></summary><div class="profile-dropdown"><strong>' + escapeHTML(data.profile.name || data.profile.username) + '</strong><p class="small">Administrator</p><button id="view-admin-profile" type="button">Account details</button><button id="logout" type="button">Sign out</button></div></details></div>' +
      '<section id="admin-profile" class="panel" hidden tabindex="-1"><div class="row"><h2>User profile</h2><button id="close-admin-profile" class="btn secondary">Close profile</button></div><p>Username: ' + escapeHTML(data.profile.name || data.profile.username) + '</p><p>Role: Administrator</p><form id="admin-name-form"><label>Admin name<input name="name" maxlength="100" required value="' + escapeHTML(data.profile.name || data.profile.username) + '"></label><p class="error" role="alert"></p><button class="btn">Save name</button></form></section>' +
      '<section id="admin-home"' + (view === 'home' ? '' : ' hidden') + '>' + renderAdminHome(data, products) + '</section>' +
      '<section id="admin-cakes"' + (view === 'cakes' ? '' : ' hidden') + '><h2>Custom cake requests</h2><p>Review client ideas, reference images, and follow-up progress.</p><div class="fields"><label>Search requests<input id="cake-request-search" type="search" placeholder="Reference, client, flavour or requirements"></label><label>Status<select id="cake-request-status"><option value="">All statuses</option><option>new</option><option>reviewed</option><option>contacted</option><option>confirmed</option><option>preparing</option><option>ready</option><option>completed</option><option>cancelled</option><option>declined</option></select></label></div><div id="cake-request-list"></div></section>' +
      '<section id="admin-dashboard"' + (view === 'dashboard' ? '' : ' hidden') + '><div class="analytics-heading"><div><span class="eyebrow">Subanese administration</span><h2>Analytics</h2><p>Orders, collections, inventory, and recorded exceptions</p></div><div class="analytics-heading-actions"><a class="btn secondary" href="#/admin?view=finance">Finance records</a><button type="button" class="btn secondary" id="dashboard-export">Export CSV</button></div></div><div class="analytics-filters"><label>Period<select id="dashboard-period"><option value="0">All time</option><option value="7">Last 7 days</option><option value="30" selected>Last 30 days</option><option value="90">Last 90 days</option></select></label><label>Fulfillment<select id="dashboard-method"><option value="">All types</option><option value="pickup">Pickup</option><option value="delivery">Delivery</option></select></label><label>Order status<select id="dashboard-status"><option value="">All statuses</option><option>confirmed</option><option>preparing</option><option>ready</option><option>out for delivery</option><option>completed</option><option>cancelled</option></select></label><label class="analytics-search">Search<input id="dashboard-search" type="search" placeholder="Customer or order reference"></label><button type="button" class="btn secondary" id="dashboard-reset">Reset</button><label>Trend<select id="dashboard-metric"><option value="value">Order value</option><option value="count">Order volume</option></select></label><label>Group by<select id="dashboard-group"><option value="day">Day</option><option value="week">Week</option><option value="month">Month</option></select></label></div><div id="dashboard-results" aria-live="polite"></div></section>' +
      '<section id="admin-transactions"' + (view === 'transactions' ? '' : ' hidden') + '><div class="row"><h2>Transactions</h2><button type="button" id="export-transactions" class="btn secondary">Export CSV</button></div><p class="small">Exports the results matching your current search and status filters. Order ledger. Order status does not confirm payment or refunds.</p><div class="fields"><label>Search<input id="transaction-search" type="search" placeholder="Reference or customer"></label><label>Order status<select id="transaction-status"><option value="">All statuses</option>' + [...new Set(data.analytics.map(order => order.status))].map(status => '<option>' + escapeHTML(status) + '</option>').join('') + '</select></label></div><div id="transaction-results" aria-live="polite"></div></section>' +
      '<section id="admin-finance"' + (view === 'finance' ? '' : ' hidden') + '><div id="finance-content"></div></section>' +
      '<section id="admin-orders"' + (view === 'orders' ? '' : ' hidden') + '><h2>Orders</h2>' +
      '<div class="table"><table>' +
        '<thead><tr>' +
          '<th>Reference</th><th>Customer</th>' +
          '<th>Bakes</th><th>Fulfillment</th>' +
          '<th>Total</th><th>Payment received</th><th>Customer email</th><th>Next step</th>' +
        '</tr></thead>' +
        '<tbody>' +
          (data.orders.length ? data.orders.map(order =>
            '<tr>' +
              '<td>' + '<a href="#/admin?view=orders&amp;order=' + encodeURIComponent(order.id) + '">' + escapeHTML(order.id) + '</a>' +
                '<br><span class="badge">' +
                  escapeHTML(order.status) +
                '</span></td>' +
              '<td>' + escapeHTML(order.name) +
                '<br>' + escapeHTML(order.email) +
                '<br>' + escapeHTML(order.phone) + '</td>' +
              '<td>' +
                order.items.map(item =>
                  escapeHTML(item.name) +
                  ' × ' + item.quantity + preferenceSummary(item)
                ).join("<br>") +
              '</td>' +
              '<td>' + escapeHTML(order.date) +
                '<br>' + escapeHTML(order.method) +
                '<br>' + escapeHTML(order.address) + deliveryLink(order.delivery_lat !== null && order.delivery_lng !== null ? {lat: order.delivery_lat, lng: order.delivery_lng} : null) + '</td>' +
              '<td>' + money(order.total) + '</td>' +
              '<td>' + orderPaymentSection(order, data.finance) + '</td>' +
              '<td>' + (order.notification ? escapeHTML({pending: 'Queued', submitted: 'Submitted to email service', failed: 'Failed ? check email service settings'}[order.notification.status] || order.notification.status) : 'No notification recorded') + '</td>' +
              '<td>' +
                nextStatuses(order).map(status =>
                  '<button class="btn secondary" data-order="' +
                    escapeHTML(order.id) +
                    '" data-status="' + status + '">' +
                    status +
                  '</button>'
                ).join("") +
              '</td>' +
            '</tr>'
          ).join("") : '<tr><td colspan="8">No orders placed yet.</td></tr>') +
        '</tbody>' +
      '</table></div>' +
      '</section><section id="admin-items"' + (view === 'items' ? '' : ' hidden') + '><h2>Items</h2><p>View all items, edit details, or remove items from the shop. Set stock to zero for temporarily unavailable items.</p>' +
      '<div class="grid admin-item-grid">' + (adminItemCards() || '<p>No items in the shop yet.</p>') + '</div><h3>Add a new item</h3>' +
      '<form id="add-item-form" class="panel">' +
        '<div class="fields"><label>Item name<input name="name" maxlength="100" required></label>' +
        '<label>Category<select name="category">' +
          [...new Set([...bakeryCategories.map(category => category.name), ...products.map(product => product.category)])].map(category => '<option>' + escapeHTML(category) + '</option>').join('') +
        '</select></label></div>' +
        '<label>Choose image<input name="image_file" type="file" accept="image/jpeg,image/png,image/webp"></label>' +
        '<p class="small">JPG, PNG or WebP up to 10 MB. A placeholder is used if no image is selected.</p>' +
        '<label>Ingredients<textarea name="ingredients" maxlength="5000" required placeholder="One ingredient per line, or separated by commas"></textarea></label>' +
        '<label>Allergens<textarea name="allergens" maxlength="1000" required placeholder="List allergens, or state if none are declared"></textarea></label>' +
        '<div class="fields"><label>Price<input name="price" type="number" min="1" max="1000000" step="1" required></label>' +
        '<label>Available stock<input name="stock" type="number" min="0" max="10000" step="1" value="12" required></label></div>' +
        '<p id="add-item-error" class="error" role="alert"></p>' +
        '<button class="btn">Add item</button>' +
      '</form>' +
    '</section></section></div>';

  const drawCakeRequests = () => {
    const query = $('#cake-request-search').value.trim().toLowerCase();
    const status = $('#cake-request-status').value;
    const cakes = data.cakes.filter(cake => (!status || cake.status === status) && [cake.id,cake.name,cake.email,cake.details.flavor,cake.details.notes,cake.details.internal_notes].join(' ').toLowerCase().includes(query));
    $('#cake-request-list').innerHTML = cakes.map(cake => {
      const details = cake.details;
      return '<article class="panel custom-request"><div class="row"><h3>' + escapeHTML(cake.id) + '</h3><span class="badge">' + escapeHTML(cake.status) + '</span></div><p><strong>' + escapeHTML(cake.name) + '</strong> &middot; ' + escapeHTML(cake.email) + '</p><p>Requested date: <strong>' + escapeHTML(details.date) + '</strong><br>Size: ' + escapeHTML(details.size) + ' &middot; Flavour: ' + escapeHTML(details.flavor) + '</p><p>Phone: ' + escapeHTML(details.phone || 'Not provided') + ' &middot; Preferred contact: ' + escapeHTML(details.preferred_contact || 'email') + '</p><h4>Client requirements</h4><p style="white-space:pre-wrap">' + escapeHTML(details.notes) + '</p>' + (details.reference_image ? '<img src="' + escapeHTML(details.reference_image) + '" alt="Client cake inspiration" loading="lazy" style="max-width:100%;width:240px;max-height:240px;object-fit:contain">' : '<p class="small">No reference image supplied.</p>') + '<form data-cake-request="' + escapeHTML(cake.id) + '"><label>Follow-up status<select name="status">' + ['new','reviewed','contacted','confirmed','preparing','ready','completed','cancelled','declined'].map(value => '<option' + (cake.status === value ? ' selected' : '') + '>' + value + '</option>').join('') + '</select></label><label>Internal bakery notes<textarea name="internal_notes" maxlength="4000" placeholder="Design details, decoration extras, quote discussions, and next steps">' + escapeHTML(details.internal_notes || '') + '</textarea></label><p class="small">Internal notes stay with the bakery. Status changes use the existing customer email notifications.</p><p class="error" role="alert"></p><button class="btn">Save follow-up</button></form></article>';
    }).join('') || '<p>No custom cake requests match your filters.</p>';
    document.querySelectorAll('[data-cake-request]').forEach(form => form.onsubmit = async event => {
      event.preventDefault();
      const button = event.submitter;
      button.disabled = true;
      try {
        const values = Object.fromEntries(new FormData(form));
        await api('/admin/cakes/' + encodeURIComponent(form.dataset.cakeRequest), 'PATCH', values);
        const cake = data.cakes.find(item => item.id === form.dataset.cakeRequest);
        cake.status = values.status;
        cake.details.internal_notes = values.internal_notes;
        drawCakeRequests();
        toast('Cake request updated.');
      } catch (error) { form.querySelector('.error').textContent = error.message; button.disabled = false; }
    });
  };
  $('#cake-request-search').oninput = drawCakeRequests;
  $('#cake-request-status').onchange = drawCakeRequests;
  drawCakeRequests();

  $('.admin-sidebar').appendChild($('.admin-toolbar'));
  syncThemeButtons();
  const drawDashboard = () => {
    const filters={period:Number($('#dashboard-period').value),method:$('#dashboard-method').value,status:$('#dashboard-status').value,query:$('#dashboard-search').value,metric:$('#dashboard-metric').value,group:$('#dashboard-group').value};
    const model=dashboardModel(data.analytics,data.finance,filters);
    model.marketingHolidays=data.marketingHolidays;
    $('#dashboard-results').innerHTML=renderAnalytics(model);
    $('#dashboard-export').onclick=()=>downloadTransactions(model.orders);
    document.querySelectorAll('[data-dashboard-exception]').forEach(button=>button.onclick=()=>{
      const kind=button.dataset.dashboardException;
      const rows=model.orders.filter(order=>kind==='unpaid'?model.unpaidIds.includes(order.id):kind==='cancelled'?order.status==='cancelled':model.incompleteIds.includes(order.id));
      $('#analytics-investigation').innerHTML='<h3>'+escapeHTML(button.textContent.trim())+'</h3>'+adminTransactions(rows);
      $('#analytics-investigation').scrollIntoView({block:'nearest',behavior:'instant'});
    });
  };
  ['#dashboard-period','#dashboard-method','#dashboard-status','#dashboard-metric','#dashboard-group'].forEach(id=>$(id).onchange=drawDashboard);
  $('#dashboard-search').oninput=drawDashboard;
  $('#dashboard-reset').onclick=()=>{$('#dashboard-period').value='30';$('#dashboard-method').value='';$('#dashboard-status').value='';$('#dashboard-search').value='';$('#dashboard-metric').value='value';$('#dashboard-group').value='day';drawDashboard();};
  drawDashboard();
  const drawTransactions = () => {
    const query = $('#transaction-search').value.trim().toLowerCase();
    const status = $('#transaction-status').value;
    const rows = data.analytics.filter(order => (!status || order.status === status) && (order.id + ' ' + order.name).toLowerCase().includes(query));
    $('#transaction-results').innerHTML = adminTransactions(rows);
    $('#export-transactions').onclick = () => downloadTransactions(rows);
  };
  $('#transaction-search').oninput = drawTransactions;
  $('#transaction-status').onchange = drawTransactions;
  drawTransactions();
  if (view === 'finance') await financePage();
  if(view==='items') {
    const params=new URLSearchParams(location.hash.split('?')[1]||'');
    const product=Number(params.get('product'));
    const form=Array.from(document.querySelectorAll('[data-edit-product]')).find(form=>Number(form.dataset.editProduct)===product);
    if(form){form.closest('details').open=true;form.scrollIntoView({block:'center'});form.querySelector('input').focus({preventScroll:true});}
    if(params.get('add')==='1'){$('#add-item-form').scrollIntoView({block:'start'});$('#add-item-form input').focus({preventScroll:true});}
  }

  const menu = $('#admin-profile-menu');
  menu.onkeydown = event => { if (event.key === 'Escape') { menu.open = false; menu.querySelector('summary').focus(); } };
  $('#admin-name-form').onsubmit = async event => {
    event.preventDefault();
    const button = event.submitter; button.disabled = true;
    try { await api('/admin/profile','PATCH',Object.fromEntries(new FormData(event.target))); await adminPage(); toast('Admin name saved.'); }
    catch(error) {event.target.querySelector('.error').textContent = error.message; button.disabled = false;}
  };
  $('#view-admin-profile').onclick = () => { menu.open = false; $('#admin-profile').hidden = false; $('#admin-profile').focus(); };
  $('#close-admin-profile').onclick = () => { $('#admin-profile').hidden = true; menu.querySelector('summary').focus(); };
  $("#logout").onclick = async () => {
    await api("/logout", "POST", {});
    adminPage();
  };

  document.querySelectorAll("[data-order]").forEach(
    button => {
      button.onclick = () =>
        adminUpdate(
          "/admin/orders/" + button.dataset.order,
          { status: button.dataset.status }
        );
    }
  );

  document.querySelectorAll('[data-order-payment]').forEach(form => {
    const amount = form.elements.amount;
    form.elements.coverage.onchange = () => {
      const partial = form.elements.coverage.value === 'partial';
      amount.closest('label').hidden = !partial;
      amount.required = partial;
    };
    form.onsubmit = async event => {
      event.preventDefault();
      const button = form.querySelector('button');
      if (button.disabled) return;
      button.disabled = true;
      form.querySelector('.error').textContent = '';
      try {
        const values = Object.fromEntries(new FormData(form));
        const order = data.orders.find(order => order.id === form.dataset.orderPayment);
        const balance = orderPaymentSummary(order, data.finance).balance;
        const amountMinor = values.coverage === 'full' ? balance : Math.round(Number(values.amount) * 100);
        if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0 || amountMinor > balance || (values.coverage === 'partial' && amountMinor >= balance)) throw Error('Enter a partial amount greater than zero and less than the remaining balance.');
        await api('/admin/finance/payments', 'POST', {order_id:order.id, amount_minor:amountMinor, method:values.method, reference:values.reference, date:values.date, status:'succeeded'});
        await adminPage();
        toast('Payment received recorded.');
      } catch (error) { form.querySelector('.error').textContent = error.message; }
      finally { if (button.isConnected) button.disabled = false; }
    };
  });

  document.querySelectorAll('[data-edit-product]').forEach(form => {
    form.onsubmit = async event => {
      event.preventDefault();
      const button = event.submitter;
      button.disabled = true;
      try {
        const values = Object.fromEntries(new FormData(form));
        const product = products.find(product => product.id === Number(form.dataset.editProduct));
        const image = await readAdminImage(form.elements.image_file.files[0], product.image_url || '');
        await api('/admin/products/' + product.id, 'PATCH', {
          name: values.name, category: values.category, price: Number(values.price), stock: Number(values.stock),
          ingredients: values.ingredients, allergens: values.allergens, image_url: image
        });
        await refreshProducts(); await adminPage(); toast('Item updated.');
      } catch (error) { toast(error.message); }
      finally { if (button.isConnected) button.disabled = false; }
    };
  });
  document.querySelectorAll('[data-delete-product]').forEach(button => {
    button.onclick = async () => {
      const product = products.find(product => product.id === Number(button.dataset.deleteProduct));
      if (!confirm('Remove "' + product.name + '" from the shop? Past orders will be kept.')) return;
      button.disabled = true;
      try {
        await api('/admin/products/' + product.id, 'DELETE', {});
        await refreshProducts(); await adminPage(); toast('Item removed from the shop.');
      } catch (error) { toast(error.message); }
      finally { if (button.isConnected) button.disabled = false; }
    };
  });

  $('#add-item-form').onsubmit = async event => {
    event.preventDefault();
    const form = event.target;
    const button = event.submitter;
    button.disabled = true;
    $('#add-item-error').textContent = '';
    try {
      const values = Object.fromEntries(new FormData(form));
      const file = form.elements.image_file.files[0];
      let image = '';
      if (file) {
        if (file.size > 10 * 1024 * 1024 || !['image/jpeg','image/png','image/webp'].includes(file.type)) throw Error('Choose a JPG, PNG or WebP up to 10 MB.');
        image = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = () => reject(Error('Could not read image.'));
          reader.readAsDataURL(file);
        });
      }
      await api('/admin/products', 'POST', {
        name: values.name, category: values.category,
        price: Number(values.price), stock: Number(values.stock),
        ingredients: values.ingredients, allergens: values.allergens, image_url: image
      });
      await refreshProducts();
      await adminPage();
      toast('Item added to the shop.');
    } catch (error) { $('#add-item-error').textContent = error.message; }
    finally { if (button.isConnected) button.disabled = false; }
  };

}

async function adminUpdate(url, body) {
  try {
    await api(url, "PATCH", body);
    await refreshProducts();
    await adminPage();
    toast("Saved.");
  } catch (error) {
    toast(error.message);
  }
}

async function refreshProducts() {
  const data = await api("/products");
  products = data.products;
  currency = data.currency;
  deliveryFee = data.deliveryFee;
}

async function route() {
  document.querySelector('.site-header #home-search')?.remove();
  await refreshCustomerAccountLink();
  document.body.classList.toggle('admin-view', location.hash.split('?')[0] === '#/admin');
  renderCategoryNavigation();
  window.scrollTo(0, 0);

  try {
    const pathname =
      location.hash.split("?")[0] || "#/";

    if (["#/", "#/shop", "#/custom"].includes(pathname)) {
      homePage();
      if (pathname !== "#/") {
        const section = pathname === "#/shop" ? '#shop-section' : '#custom-section';
        requestAnimationFrame(() => $(section)?.scrollIntoView({block:'start'}));
      }
    } else if (pathname === "#/checkout") {
      checkoutPage();

    } else if (["#/account", "#/register", "#/track"].includes(pathname)) {
      if (pathname === "#/track") { location.hash = "#/account?view=tracking"; return; }
      await customerAccountPage(pathname === "#/register");
    } else if (pathname.startsWith("#/order/")) {
      await orderPage();
    } else if (pathname === "#/admin") {
      await adminPage();
    } else {
      homePage();
    }
  } catch (error) {
    main.innerHTML =
      '<section class="section">' +
        '<h2>We couldn’t load that.</h2>' +
        '<p class="error">' +
          escapeHTML(error.message) +
        '</p>' +
        '<a href="#/" class="btn">Back to the bakery</a>' +
      '</section>';
  }
}

$("#close-cake").onclick = () => $("#cake-details").close();
$("#cake-details").addEventListener("click", event => {
  const dialog = $("#cake-details");
  if (event.target !== dialog) return;
  const bounds = dialog.getBoundingClientRect();
  if (event.clientX < bounds.left || event.clientX > bounds.right ||
      event.clientY < bounds.top || event.clientY > bounds.bottom) {
    dialog.close();
  }
});
$("#bag").onclick = openBag;

$("#cart").addEventListener("click", event => {
  if (event.target !== $("#cart")) return;
  const bounds = $("#cart").getBoundingClientRect();
  if (event.clientX < bounds.left || event.clientX > bounds.right ||
      event.clientY < bounds.top || event.clientY > bounds.bottom) {
    $("#cart").close();
  }
});

$("#close-cart").onclick = () => $("#cart").close();

let observedAppVersion = null;
let versionCheckRunning = false;
async function checkForAppChanges() {
  if (versionCheckRunning || document.hidden) return;
  versionCheckRunning = true;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2500);
  try {
    const response = await fetch('/api/app-version', {cache:'no-store',signal:controller.signal});
    if (!response.ok) return;
    const state = await response.json();
    if (!state.liveReload) return;
    if (observedAppVersion !== null && observedAppVersion !== state.version) { location.reload(); return; }
    observedAppVersion = state.version;
  } catch { /* Retry after the development server finishes restarting. */ }
  finally {clearTimeout(timeout); versionCheckRunning = false;}
}
checkForAppChanges();
setInterval(checkForAppChanges, 2000);
document.addEventListener('visibilitychange', () => {if (!document.hidden) checkForAppChanges();});

window.onhashchange = () => {
  $("#cake-details").close();
  $("#cart").close();
  route();
};

refreshProducts()
  .then(() => {
    saveBag();
    route();
  })
  .catch(error => toast(error.message));
</script>
</body>
</html>
`;

const emailTimer = setInterval(() => { void emailQueue.flush(); }, 30000);
emailTimer.unref();
server.on('close', () => clearInterval(emailTimer));
void emailQueue.flush();

server.listen(PORT, process.env.HOST || "127.0.0.1", () => {
  console.log(
    "pastries by subanesse is running at http://localhost:" + PORT
  );
});

