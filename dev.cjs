const {spawn}=require('node:child_process');
const path=require('node:path');
const frontend=spawn(process.execPath,[path.join(__dirname,'build.cjs'),'--watch'],{stdio:'inherit'});
// Node watches the server and required modules; the browser watches asset versions.
const server=spawn(process.execPath,['--watch',path.join(__dirname,'server.cjs')],{stdio:'inherit',env:{...process.env,NODE_ENV:'development'}});
server.on('exit',code=>{frontend.kill();process.exitCode=code||0;});
frontend.on('error',error=>{console.error(error.message);server.kill();process.exitCode=1;});
frontend.on('exit',code=>{if(code){server.kill();process.exitCode=code;}});
server.on('error',error=>{console.error(error.message);frontend.kill();process.exitCode=1;});
process.on('SIGINT',()=>{frontend.kill();server.kill('SIGINT');});
process.on('SIGTERM',()=>{frontend.kill();server.kill('SIGTERM');});
