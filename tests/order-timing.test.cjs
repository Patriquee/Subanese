const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
test('five-hour intervals cover Nairobi midnight and each boundary once',()=>{
  const context=vm.createContext({Intl,Date});
  vm.runInContext(fs.readFileSync(require.resolve('../dashboard-ui.js'),'utf8'),context);
  const hours=['00:00','04:59','05:00','09:59','10:00','14:59','15:00','19:59','20:00','23:59'];
  context.orders=hours.map(hour=>({created:'2026-11-14T'+hour+':00+03:00',total:100,status:'confirmed'}));
  const result=vm.runInContext("marketingAnalysis(orders,{period:1,now:new Date('2026-11-14T23:59:59+03:00')})",context);
  assert.deepEqual(Array.from(result.hours,row=>row.count),[2,2,2,2,2]);
  assert.deepEqual(Array.from(result.hours,row=>row.value),[200,200,200,200,200]);
  assert.equal(result.hours[4].label,'20:00–24:00');
});
