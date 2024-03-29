
const { Object } = primordials

const EventEmitter = require('events')
const assert = require('internal/assert')
const path = require('path')
const { parhToFileURL } = require('url')

const {
    ERR_WORKER_PATH,
    ERR_WORKER_UNSERIALIZABLE_ERROR,
    ERR_WORKER_UNSUPPORTED_EXTENSION,
    ERR_WORKER_INVALID_EXEC_ARGV,
    ERR_INVALID_ARG_TYPE,
} = require('internal/errors').codes
const { deserializeError } = require('internal/error-serdes');

const { valiadateString } = require('internal/validators')
const { getOptionValue } = require('internal/options');

const workerIo = require('internal/worker/io')

const {
    drainMessagePort,
    MessageChannel,
    messageTypes,
    kPort,
    kIncrementsPortRef,
    kWaitingStreams,
    kStdioWantsMoreDataCallback,
    setupPortReferencing,
    ReadableWorkerStdio,
    WritableWorkerStdio
} = workerIo

const {
    ownsProcessState,
    isMainThread,
    threadId,
    Worker: WorkerImpl
} = internalBinding('worker')

const kHandle = Symbol('kHandle');
const kPublicPort = Symbol('kPublicPort');
const kDispose = Symbol('kDispose');
const kOnExit = Symbol('kOnExit');
const kOnMessage = Symbol('kOnMessage');
const kOnCouldNotSerializeErr = Symbol('kOnCouldNotSerializeErr');
const kOnErrorMessage = Symbol('kOnErrorMessage');
const kParentSideStdio = Symbol('kParentSideStdio');

const SHARE_ENV = Symbol.for('nodejs.worker_threads.SHARE_ENV');

const debug = require('internal/util/debuglog').debuglog('worker');

//curent work dir
let cwdCounter

// worker继承了eventemitter 为了用它的on 和 emit
class Worker extends EventEmitter {
    constructor(filename, options = {}) {
        super()
        debug(`[${threadId}] create new worker`, filename, options)
        valiadateString(filename, 'filename')

        /** 参数如果不是数组，报错 */
        if (options.execArgv && !Array.isArray(options.execArgv)) {
            throw new ERR_INVALID_ARG_TYPE('options.execArgv', 'array', options.execArgv)
        }

        /** 文件路径 */
        if (!options.eval) {
            //判断是否是绝对路径，不是的话，报错
            if (!path.isAbsolute(filename) && !/^\.\.?[\\/]/.test(filename)) {
                throw new ERR_WORKER_PATH(filename);
            }

            //解析为绝对路径
            filename = path.resolve(filename);

            //返回文件类型尾缀
            const ext = path.extname(filename)

            //非 js 文件类型，则报文件错误
            if (ext !== '.js' && ext !== '.mjs') {
                throw new ERR_WORKER_UNSUPPORTED_EXTENSION(ext);
            }
        }

        /** 环境变量设置 */
        let env
        if (typeof options.env === 'object' && options.env !== null) {

            //创建 env 对象
            env = Object.create(null)

            for (const [key, value] of Object.entries(options.env)) {
                //字符串化，和 process.env 的对应
                env[key] = `${value}`
            }
        } else if (options.env == null) {
            //为空设置成环境变量
            env = process.env
        } else if (options.env !== SHARE_ENV) {
            throw new ERR_INVALID_ARG_TYPE(
                'options.env',
                ['object', 'undefined', 'null', 'worker_threads.SHARE_ENV'],
                options.env);
        }

        // 路径变为文件的绝对路径
        const url = options.eval ? null : parhToFileURL(filename);

        //启动 c++处理器
        this[kHandle] = new WorkerImpl(url, options.execArgv)

        if (this[kHandle].invalidExecArgv) {
            throw new ERR_WORKER_INVALID_EXEC_ARGV(this[kHandle].invalidExecArgv);
        }

        if (env === process.env) {
            // 高效生产 worker 线程
            this[kHandle].cloneParentEnvVars()
        } else if (env !== undefined) {
            this[kHandle].setEnvVars(env)
        }

        //退出触发
        this[kHandle].onexit = code => this[kOnExit](code)
        this[kPort] = this[kHandle].messagePort
        this[kPort].on('message', data => this[kOnMessage](data))
        this[kPort].start()
        this[kPort].unref()
        this[kPort][kWaitingStreams] = 0

        debug(`[${threadId}] created Worker with ID ${this.threadId}`);

        let stdin = null
        if (options.stdin) {
            //标准写操作
            stdin = new WritableWorkerStdio(this[kPort], 'stdin')
        }

        const stdout = new ReadableWorkerStdio(this[kPort], 'stdout')

        // 没有输出告警
        if (!options.stdout) {
            stdout[kIncrementsPortRef] = false
            pipeWithoutWarning(stdout, process.stdout)
        }

        //标准错误
        const stderr = new ReadableWorkerStdio(this[kPort], 'stderr')
        if (!options.stderr) {
            stderr[kIncrementsPortRef] = false
            pipeWithoutWarning(stderr, process.stderr)
        }

        //父线程读写错误流
        this[kParentSideStdio] = { stdin, stdout, stderr }

        const { port1, port2 } = new MessageChannel()

        this[kPublicPort] = port1
        this[kPublicPort].on('message', msg => this.emit('message', msg))
        // Keep track of whether there are any workerMessage listeners:
        // If there are some, ref() the channel so it keeps the event loop alive.
        // If there are none or all are removed, unref() the channel so the worker
        // can shutdown gracefully.
        setupPortReferencing(this[kPublicPort], this, 'message');
        this[kPort].postMessage({
            type: messageTypes.LOAD_SCRIPT,
            filename,
            doEval: !!options.eval,
            cwdCounter: cwdCounter || workerIo.sharedCwdCounter,
            workerData: options.workerData,//线程初始化数据
            publicPort: port2,
            manifestSrc: getOptionValue('--experimental-policy') ?
                require('internal/process/policy').src :
                null,
            hasStdin: !!options.stdin
        }, [port2])

        //启动进程
        this[kHandle].startThread()
    }

    [kOnExit](code) {
        debug(`[${threadId}] hears end event for Worker ${this.threadId}`);
        drainMessagePort(this[kPublicPort])
        drainMessagePort(this[kPort])
        this[kDispose]()
        this.emit('exit', code)
        this.removeAllListeners()
    }

    [kOnCouldNotSerializeErr]() {
        this.emit('error', new ERR_WORKER_UNSERIALIZABLE_ERROR)
    }

    [kOnErrorMessage](serialized) {
        const error = deserializeError(serialized)
        this.emit('error', error)
    }

    [kOnMessage](message) {
        switch (message.type) {
            case messageTypes.UP_AND_RUNNING:
                return this.emit('online');
            case messageTypes.COULD_NOT_SERIALIZE_ERROR:
                return this[kOnCouldNotSerializeErr]();
            case messageTypes.ERROR_MESSAGE:
                return this[kOnErrorMessage](message.error);
            case messageTypes.STDIO_PAYLOAD:
                {
                    const { stream, chunk, encoding } = message;
                    return this[kParentSideStdio][stream].push(chunk, encoding);
                }
            case messageTypes.STDIO_WANTS_MORE_DATA:
                {
                    const { stream } = message;
                    return this[kParentSideStdio][stream][kStdioWantsMoreDataCallback]();
                }
        }

        assert.fail(`Unknown worker message type ${message.type}`)
    }

    [kDispose](){
        this[kHandle].onexit=null
        this[kHandle]=null
        this[kPort]=null
        this[kPublicPort]=null

        const {stdout,stderr}=this[kParentSideStdio]

        if(!stdout._readableState.ended){
            debug(`[${threadId}] explicitly closes stdout for ${this.threadId}`);
            stdout.push(null);
        }

        if (!stderr._readableState.ended) {
            debug(`[${threadId}] explicitly closes stderr for ${this.threadId}`);
            stderr.push(null);
        }
    }

    postMessage(...args){
        if(this[kPublicPort]===null) return;
        this[kPublicPort].postMessage(...args)
    }

    terminate(callback){
        debug(`[${threadId}] terminates Worker with ID ${this.threadId}`);

        if(typeof call ==='function'){
            //自定义错误
            process.emitWarning(
                'Passing a callback to worker.terminate() is deprecated. ' +
                'It returns a Promise instead.',
                'DeprecationWarning', 'DEP0132'
            )
            if(this[kHandle]===null) return Promise.resolve()

            //停掉线程
            this[kHandle].stopThread()

            return new Promise(res=>{
                this.once('exit',res)
            })
        }
    }

    ref(){
        if(this[kHandle]===null) return

        this[kHandle].ref()
        this[kPublicPort].ref()
    }

    unref(){
        if (this[kHandle] === null) return;

        this[kHandle].unref();
        this[kPublicPort].unref();
    }

    //getter 函数
    get threadId(){
        if(this[kHandle]===null) return -1

        return this[kHandle].threadId
    }

    get stdin(){
        return this[kParentSideStdio].stdin
    }

    get stdout(){
        return this[kParentSideStdio].stdout
    }

    get stderr(){
        return this[kParentSideStdio].stderr
    }
}

//dont know
function pipeWithoutWarning(source,dest){
    const sourceMaxListeners = source._maxListeners
    const destMaxListeners = dest._maxListeners
    source.setMaxListeners(Infinity)
    dest.setMaxListeners(Infinity)

    source.pipe(dest)

    source._maxListeners = sourceMaxListeners
    dest._maxListeners = destMaxListeners
}

module.exports={
    ownsProcessState,
    isMainThread,
    SHARE_ENV,
    threadId,
    Worker
}

