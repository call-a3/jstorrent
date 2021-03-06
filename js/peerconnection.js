var peerSockMap = {}

function onTCPReceive(info) {
    var sockId = info.socketId
    if (peerSockMap[sockId]) {
        peerSockMap[sockId].onReadTCP(info)
    }
}

chrome.sockets.tcp.onReceive.addListener( onTCPReceive )


function PeerConnection(opts) {
    jstorrent.Item.apply(this, arguments)

    
    this.peer = opts.peer
    this.torrent = opts.peer.torrent



    // initial bittorrent state settings
    this.amInterested = false
    this.amChoked = true

    this.readThrottled = false

    this.peerInterested = false
    this.peerChoked = true
    this.set('peerChoked',true)
    this.set('amChoked',true)

    this.sentHandshake = false
    this.sentExtensionHandshake = false
    this.sentBitfield = false

    this.connectedWhen = null

    this.peerHandshake = null
    this.peerExtensionHandshake = null
    this.peerExtensionHandshakeCodes = {}
    this.peerPort = null
    this.peerBitfield = null

    this.set('address', this.peer.get_key())
    this.set('bytes_sent', 0)
    this.set('bytes_received', 0)
    this.set('requests',0)
    this.set('responses',0)
    this.set('timeouts',0)
    this.set('outstanding',0)

    this.set('complete',0)

    // TODO -- if we have a peer that we keep sending "HAVE" messages
    // to and even those tiny messages don't get flushed out of the
    // buffer, then that peer SUCKS and we should disconnect (if there
    // are potentially healthier peers in the swarm.

    // this may also be the cause of the dreaded 99.9%, we have a peer that we sent chunk requests to, and for some reason we haven't timed them out correctly... ?

    // piece/chunk requests
    this.pieceChunkRequests = {} // XXX not being stored here? wtf. we need that data!!!

    this.outstandingPieceChunkRequestCount = 0// "outstanding"
    this.pieceChunkRequestPipelineLimit = 2 // TODO - make self adjusting

    // inefficient that we create this for everybody in the
    // swarm... (not actual peer objects) but whatever, good enough
    // for now
    this.registeredRequests = {}
    this.infodictResponses = []
    this.handleAfterInfodict = []

    // connect state
    if (jstorrent.device.platform == 'Android') {
        this.connect_timeout_delay = 1000 // BUG THIS BLOCKS MAIN THREAD
    } else {
        this.connect_timeout_delay = 10000
    }
    this.connect_timeout_callback = null
    this.connecting = false
    this.connect_timeouts = 0

    // read/write buffer stuff
    this.writing = false
    this.writing_length = 0
    this.reading = false
    this.readBuffer = new jstorrent.Buffer
    this.writeBuffer = new jstorrent.Buffer

    this.hasclosed = false
}

jstorrent.PeerConnection = PeerConnection;

PeerConnection.prototype = {
    registerPieceChunkRequest: function(pieceNum, chunkNum) {
        this.pieceChunkRequests[pieceNum + '/' + chunkNum] = true
    },
    requestedPieceChunk: function(pieceNum, chunkNum) {
        return this.pieceChunkRequests[pieceNum + '/' + chunkNum]
    },
    registerPieceChunkTimeout: function(pieceNum, chunkNum) {
        this.outstandingPieceChunkRequestCount--
        this.set('outstanding',this.get('outstanding')-1)
        var hadRequest = this.pieceChunkRequests[pieceNum + '/' + chunkNum]
        console.assert(hadRequest)
        delete this.pieceChunkRequests[pieceNum + '/' + chunkNum]
        this.set('timeouts', this.get('timeouts')+1)
        this.newStateThink() // make sure to do this! or we get stuck doin nothin'
    },
    cleanup: function() {
        this.readBuffer.clear()
        this.writeBuffer.clear()
    },
    cleanupRequests: function() {
        // when does this get called?
        var idx = this.torrent.connectionsServingInfodict.indexOf(this)
        if (idx != -1) {
            console.log('removing self from connections serving infodicts')
            this.torrent.connectionsServingInfodict.splice(idx, 1)
        }

        var parts, pieceNum, chunkNum, piece, chunkRequests, chunkRequest
        for (var key in this.pieceChunkRequests) {
            parts = key.split('/')
            pieceNum = parts[0]
            chunkNum = parts[1]
            if (this.torrent.pieces.containsKey(pieceNum)) {
                piece = this.torrent.pieces.get(pieceNum)
                chunkRequests = piece.chunkRequests[chunkNum]
                if (chunkRequests && chunkRequests.length > 0) {

                    for (var i=0; i<chunkRequests.length; i++) {
                        chunkRequest = chunkRequests[i]
                        if (chunkRequest.peerconn == this) {
                            // DELETE this fucker!
                            //console.log('peer disconnected that had outstanding chunk request and we deleted it. yay')
                            // delete chunkRequests[i] // delete dont work cuz .length still set, gotta do splice
                            chunkRequests.splice(i,1) // XXX - it removes the entry, but requests still not being made!
                            break
                        }
                    }

                }
            }
        }
    },
    updatePercentComplete: function() {
        var count = 0
        for (var i=0; i<this.torrent.numPieces; i++) {
            count += this.peerBitfield[i]
        }
        var val = count / this.torrent.numPieces
        this.set('complete',val)
    },
    get_key: function() {
        return this.peer.host + ':' + this.peer.port
    },
    on_connect_timeout: function() {
        //console.log(this.get_key(),'connect timeout')
        this.connecting = false;
        this.connect_timeouts++;
        if (! peerSockMap[this.sockInfo.socketId]) { debugger }
        //if (peerSockMap[this.sockInfo.socketId] === undefined) { return } // FIXME -- somebody should have cleared the connect timeout already
        chrome.sockets.tcp.close( this.sockInfo.socketId, this.onClose.bind(this) ) // seeing a warning unchecked chrome.runtime.lastError even though we check it in this callback ???
        // perhaps this is because when a socket gets a lastError (e.g. ERR_CONNECTION_REFUSED its implied to be closed already)
        if (chrome.runtime.lastError) {
            console.warn('close sync lastError',chrome.runtime.lastError)
        }
        delete peerSockMap[this.sockInfo.socketId]
        this.sockInfo = null
        this.trigger('connect_timeout')
    },
    close: function(reason) {
        //console.log('socket close',reason)
        // XXX TODO -- does this always get called when the socket closes/peer disconnects/they leave peer list?
        if (this.connect_timeout_callback) { clearTimeout(this.connect_timeout_callback) }
        if (this.hasclosed) {
            // this can happen when we stop the torrent while we are
            // reading from the socket and we get the onRead event
            // nothing to worry about too much... though it would be
            // nice to get a better handle on all the possible cases
            // of stopping/closing etc while read events are pending.

            //console.assert(! this.hasclosed)
            return
        }

/*
        if (this.writing || this.reading) {
            //console.warn('called close on socket that had pending read/write callbacks')
        }
*/
        
        this.hasclosed = true
        //this.log('closing',reason)

        // unfortunately the pending read/write callbacks still get
        // triggered... make sure we look for sockInfo being gone
        this.cleanupRequests()
        this.cleanup()
        if (this.sockInfo) {
            // if no this.sockInfo, perhaps we were not yet connected
            if (this.connectedWhen) {
                chrome.sockets.tcp.disconnect(this.sockInfo.socketId, this.onDisconnect.bind(this))
            }
            chrome.sockets.tcp.close(this.sockInfo.socketId, this.onClose.bind(this))
            delete peerSockMap[this.sockInfo.socketId]
        }
        this.sockInfo = null
        // need to clean up registerd requests
        this.trigger('disconnect')
    },
    onDisconnect: function(result) {
        if (chrome.runtime.lastError) {
            //console.warn('ondisconnect lasterror',chrome.runtime.lastError.message)
        }
    },
    onClose: function(result) {
        if (chrome.runtime.lastError) {
            //console.warn('onclose lasterror',chrome.runtime.lastError.message) // TODO -- "Socket not found" ?
            // double close, not a big deal. :-\
        }
    },
    connect: function() {
        //console.log(this.get_key(),'connecting...')
        console.assert( ! this.connecting )
        this.connecting = true;
        this.set('state','connecting')
        chrome.sockets.tcp.create({}, _.bind(this.oncreate, this))
    },
    oncreate: function(sockInfo) {
        this.sockInfo = sockInfo;
        peerSockMap[this.sockInfo.socketId] = this
        //this.log('peer oncreate')
        this.connect_timeout_callback = setTimeout( _.bind(this.on_connect_timeout, this), this.connect_timeout_delay )
        chrome.sockets.tcp.connect( sockInfo.socketId, this.peer.host, this.peer.port, _.bind(this.onconnect, this) )
    },
    onconnect: function(connectInfo) {
        if (chrome.runtime.lastError) {
            //console.log('onconnect lasterror',chrome.runtime.lastError)
            this.peer.set('connectionResult', chrome.runtime.lastError.message)
            this.error('connect_error')
            return
        }
        //console.log(this.get_key(),'connected.',connectInfo)
        if (this.hasclosed) { return } // XXX -- better handling for closing of sockets still in connecting state?

        this.connectedWhen = new Date()
        if (connectInfo < 0) {
            this.peer.set('connectionResult', connectInfo)

            //console.error('socket connect error:',connectInfo)
            this.error('connect_error')
            return
        }

        if (! this.sockInfo) {
            console.log('onconnect, but we already timed out')
        }
        //console.log(this.get_key(),'connected!')
        //this.log('peer onconnect',connectInfo);
        this.set('state','connected')
        this.peer.set('connected_ever',true)
        if (this.connect_timeout_callback) {
            clearTimeout( this.connect_timeout_callback )
            this.connect_timeout_callback = null
            this.connecting = false
        }

        this.torrent.maybePropagatePEX({added: this.peer.serialize()})

        this.doRead()
        this.sendHandshake()
        this.sendExtensionHandshake()
        if (this.torrent.has_infodict()) {
            this.sendBitfield()
        }
    },
    doRead: function() {
        console.assert(! this.reading)
        if (this.hasclosed) { return }
        if (this.reading) { return }
        this.reading = true
        // chrome.sockets.tcp.read( this.sockInfo.socketId, jstorrent.protocol.socketReadBufferMax, _.bind(this.onRead,this) ) // new socket API doesnt do it this way
    },
    sendExtensionHandshake: function() {
        this.sentExtensionHandshake = true
        if (this.peerHandshake &&
            (this.peerHandshake.reserved[5] & 0x10) == 0) {
            // will not send extension handshake to people that don't have 0x10 in 6th byte...
            return
        }
        var data = {v: jstorrent.protocol.reportedClientName,
//                    p: 6666, // our listening port
                    m: jstorrent.protocol.extensionMessages}
        if (this.torrent.has_infodict()) {
            data.metadata_size = this.torrent.infodict_buffer.byteLength
        }
        var arr = new Uint8Array(bencode( data )).buffer;
        this.sendMessage('UTORRENT_MSG', [new Uint8Array([0]).buffer, arr])
    },
    sendMessage: function(type, payloads) {
        if (this.hasclosed) {
            // connection was closed, yo
            return
        }
        this.set('last_message_sent',type)
        switch (type) {
        case "INTERESTED":
            this.amInterested = true
            break
        case "NOT_INTERESTED":
            this.amInterested = false
            break
        case "CHOKE":
            this.peerChoked = true
            this.set('peerChoked',true)
            break
        case "UNCHOKE":
            this.peerChoked = false
            this.set('peerChoked',false)
            break
        }
        
        if (! payloads) { payloads = [] }
        //console.log('Sending Message',type)
        console.assert(jstorrent.protocol.messageNames[type] !== undefined)
        var payloadsz = 0
        for (var i=0; i<payloads.length; i++) {
            console.assert(payloads[i] instanceof ArrayBuffer)
            payloadsz += payloads[i].byteLength
        }
        var b = new Uint8Array(payloadsz + 5)
        var v = new DataView(b.buffer, 0, 5)
        v.setUint32(0, payloadsz + 1) // this plus one is important :-)
        v.setUint8(4, jstorrent.protocol.messageNames[type])
        var idx = 5
        for (var i=0; i<payloads.length; i++) {
            b.set( new Uint8Array(payloads[i]), idx )
            idx += payloads[i].byteLength
        }
        //console.log('sending message', new Uint8Array(b))
        this.write(b.buffer)
    },
    sendHandshake: function() {
        this.sentHandshake = true
        var bytes = []
        bytes.push( jstorrent.protocol.protocolName.length )
        for (var i=0; i<jstorrent.protocol.protocolName.length; i++) {
            bytes.push( jstorrent.protocol.protocolName.charCodeAt(i) )
        }
        // handshake flags, null for now
        bytes = bytes.concat( jstorrent.protocol.handshakeFlags )
        bytes = bytes.concat( this.torrent.hashbytes )
        bytes = bytes.concat( this.torrent.client.peeridbytes )
        console.assert( bytes.length == jstorrent.protocol.handshakeLength )
        var payload = new Uint8Array( bytes ).buffer
        //console.log('Sending Handshake',['HANDSHAKE',payload])
        this.write( payload )
    },
    write: function(data) {
        //console.log('peer write',data,data.byteLength)
        console.assert(! this.hasclosed)
        console.assert(data.byteLength > 0)
        console.assert(data instanceof ArrayBuffer)
        this.writeBuffer.add(data)
        if (! this.writing) {
            this.writeFromBuffer()
        }
    },
    writeFromBuffer: function() {
        console.assert(! this.hasclosed)
        if (! this.sockInfo) {
            //console.error('cannot write from buffer, sockInfo null (somebody closed connection on us...)')
            console.warn('sockInfo missing writeFromBuffer')
            return
        }
        console.assert(! this.writing)
        var data = this.writeBuffer.consume_any_max(jstorrent.protocol.socketWriteBufferMax)
        //this.log('write',data.byteLength)
        this.writing = true
        this.writing_length = data.byteLength
        chrome.sockets.tcp.send( this.sockInfo.socketId, data, _.bind(this.onWrite,this) )
    },
    onWrite: function(writeResult) {
        if (chrome.runtime.lastError) {
            //console.warn('lasterror on tcp.send',chrome.runtime.lastError,writeResult.resultCode)
        }

        if (! this.sockInfo) {
            //console.error('onwrite for socket forcibly or otherwise closed')
            return
        }

        //this.log('onWrite', writeResult)
        // probably only need to worry about partial writes with really large buffers
        if (writeResult.resultCode < 0) {
            //console.warn('sock onwrite resultcode',writeResult.resultCode)
            this.error('negative onwrite')
        } else if (writeResult.bytesSent != this.writing_length) {
            if (writeResult.bytesSent == 0) {
                this.close('bytesSent==0, closed connection')
            } else if (writeResult.bytesSent < 0) {
                this.error('negative bytesSent',writeResult.bytesSent)
            } else {
debugger
                console.error('bytes written does not match!, was',writeResult.bytesSent,'should be',this.writing_length)
/*
                chrome.socket.getInfo( this.sockInfo.socketId, function(socketStatus) {
                    console.log('socket info -',socketStatus)
                })
*/
                this.error('did not write everything')
            }

        } else {
            this.set('bytes_sent', this.get('bytes_sent') + this.writing_length)
            this.torrent.countBytes('sent', this.writing_length)
            //this.torrent.set('uploaded', this.torrent.get('uploaded') + this.writing_length) // cheating? what is "uploaded" supposed to be, anyway
            this.writing = false
            this.writing_length = 0
            // continue writing out write buffer
            if (this.writeBuffer.size() > 0) {
                this.writeFromBuffer()
            } else {
                this.newStateThink()
            }
        }
    },
    couldRequestPieces: function() {
        // XXX -- in endgame mode, make sure all the fastest effective players get everything
        if (app.options.get('debug_dht')) { return }

        //console.log('couldRequestPieces')
        if (this.outstandingPieceChunkRequestCount > this.pieceChunkRequestPipelineLimit) {
            return
        }

        var lim = this.torrent.client.app.options.get('max_unflushed_piece_data') * Math.max(this.torrent.pieceLength,
                                                                                             jstorrent.protocol.chunkSize * 128)



        if (this.torrent.unflushedPieceDataSize > lim) {
            //console.log('not requesting more pieces -- need disk io to write out more first')
            return
        }

        // called when everything is ready and we could request
        // torrent pieces!
        var curPiece, payloads
        var allPayloads = []

        var bridgekeys = _.keys(this.torrent.bridges)
        if (bridgekeys.length > 0) {
            var bridgeidx = Math.floor(Math.random() * bridgekeys.length) 
            var curbridge = this.torrent.bridges[ bridgekeys[bridgeidx] ]
            var startAtPiece = curbridge.startPiece // TODO -- update startpiece as we go along

            // TODO -- we can make an educated guess that the bridge
            // is at the end of the file (say in the last 2%, which
            // means that it is to complete the metadata, and so
            // temporarily turn on endgame for these bridge pieces...
        } else {
            var startAtPiece = this.torrent.bitfieldFirstMissing
        }


        for (var pieceNum=startAtPiece; pieceNum<this.torrent.numPieces; pieceNum++) {
            if (this.peerBitfield[pieceNum] && ! this.torrent.havePieceData(pieceNum)) {
                if (this.torrent.pieceBlacklist[pieceNum]) { continue }
                curPiece = this.torrent.getPiece(pieceNum)
                if (curPiece.haveData) { continue } // we have the data for this piece, we just havent hashed and persisted it yet

                while (this.outstandingPieceChunkRequestCount < this.pieceChunkRequestPipelineLimit) {
                    //console.log('getting chunk requests for peer')

                    // what's ideal batch number?
                    payloads = curPiece.getChunkRequestsForPeer(2, this)
                    if (payloads.length == 0) {
                        break
                    } else {
                        this.outstandingPieceChunkRequestCount += payloads.length
                        this.set('outstanding',this.get('outstanding')+payloads.length)
                        allPayloads = allPayloads.concat(payloads)
                    }
                }
            }

            if (this.outstandingPieceChunkRequestCount >= this.pieceChunkRequestPipelineLimit) {
                break
            }
        }

        if (allPayloads.length > 0) {
            for (var i=0; i<allPayloads.length; i++) {
                this.set('requests',this.get('requests')+1)
                this.sendMessage("REQUEST", [allPayloads[i]])
            }
        } else {
            // nothing to do now, but maybe in a second we will have something to do... (bridge race condition)
            setTimeout( function() {
                this.newStateThink()
            }.bind(this), 1000 )
        }
    },
    registerExpectResponse: function(type, key, info) {
        // used for non-PIECE type messages
        if (! this.registeredRequests[type]) {
            this.registeredRequests[type] = {}
        }
        this.registeredRequests[type][key] = info
    },
    cancelAnyRequestsForPiece: function(piece) {
        
    },
    newStateThink: function() {
        if (! this.readThrottled) {
            while (this.checkBuffer()) {}
        }

        if (this.torrent.isComplete()) { 

            if (this.get('complete') == 1) {
                if (! this.peerInterested) {
                    this.close('both complete and peer not interested')
                }
            }

            return 
        }
        // thintk about the next thing we might want to write to the socket :-)
        if (this.torrent.has_infodict()) {

            // we have valid infodict
            if (this.handleAfterInfodict.length > 0) {
                //console.log('processing afterinfodict:',this.handleAfterInfodict)
                var msg = this.handleAfterInfodict.shift()
                //setTimeout( _.bind(function(){this.handleMessage(msg)},this), 1 )
                this.handleMessage(msg)
            } else {
                if (this.torrent.started) {
                    if (! this.amInterested) {
                        this.sendMessage("INTERESTED")
                    } else {
                        if (! this.amChoked) {
                            if (this.peerBitfield) {
                                this.couldRequestPieces()
                            }
                        }
                    }
                }
            }
        } else {
            if (this.peerExtensionHandshake && 
                this.peerExtensionHandshake.m && 
                this.peerExtensionHandshake.m.ut_metadata &&
                this.peerExtensionHandshake.metadata_size &&
                this.torrent.connectionsServingInfodict.length < this.torrent.connectionsServingInfodictLimit)
            {
                // we have no infodict and this peer does!
                if (! this.registeredRequests['infodictRequest']) { // dont do this again lol
                    this.torrent.connectionsServingInfodict.push( this )
                    this.requestInfodict()
                }
            }
        }
    },
    requestInfodict: function() {
        // TODO -- add timeout handling
        var infodictBytes = this.peerExtensionHandshake.metadata_size
        var d
        var numChunks = Math.ceil( infodictBytes / jstorrent.protocol.pieceSize )
        //console.log('requestinfodict determines # chunks',numChunks)

        this.infodictResponses = []
        for (var i=0; i<numChunks; i++) {
            this.infodictResponses.push(null)
        }

        for (var i=0; i<numChunks; i++) {
            d = {
                piece: i,
                msg_type: jstorrent.protocol.infodictExtensionMessageNames.REQUEST,
                total_size: infodictBytes // do we need to send this?
            }
            var code = this.peerExtensionHandshake.m.ut_metadata
            var info = {}
            this.registerExpectResponse('infodictRequest', i, info)
            //console.log(this.get('address'),'requested infodict',d)
            this.sendMessage('UTORRENT_MSG', [new Uint8Array([code]).buffer, new Uint8Array(bencode(d)).buffer])
        }
    },
    log: function() {
        var args = [this.sockInfo.socketId, this.peer.get_key()]
        for (var i=0; i<arguments.length; i++) {
            args.push(arguments[i])
        }
        console.log.apply(console, args)
    },
    error: function(msg) {
        //this.log(msg)
        if (this.connectedWhen) {
            chrome.sockets.tcp.disconnect(this.sockInfo.socketId, this.onDisconnect.bind(this))
        }
        chrome.sockets.tcp.close(this.sockInfo.socketId, this.onClose.bind(this))
        this.trigger('error')
    },
    shouldThrottleRead: function() { 
        return false
        // if byte upload rate too high?
        if (this.peer.host == '127.0.0.1') { return true }
    },
    checkShouldUnthrottleRead: function() {
        if (true) { // throttling just means a delay for now
            if (! this.hasclosed) {
                this.readThrottled = false
                this.checkBuffer()
                this.doRead()
            }
        }
    },
    onReadTCP: function(readResult) {
        this.onRead(readResult)
    },
    onRead: function(readResult) {
        //console.log('onread',readResult,readResult.data.byteLength, [ui82str(new Uint8Array(readResult.data))])
        if (! this.torrent.started) {
            //console.error('onRead, but torrent stopped')
            this.close('torrent stopped')
        }

        this.reading = false
        if (! this.sockInfo) {
            //console.error('onRead for socket forcibly or otherwise closed')
            return
        }
        if (readResult.data.byteLength == 0) {
            this.close('peer closed socket (read 0 bytes)')
            return
        } else {
            this.set('bytes_received', this.get('bytes_received') + readResult.data.byteLength)
            this.torrent.countBytes('received', readResult.data.byteLength)
            //this.log('onRead',readResult.data.byteLength)
            this.readBuffer.add( readResult.data )

            //this.doRead() // TODO -- only if we are actually interested right now...
            if (this.shouldThrottleRead()) {
                this.readThrottled = true
                setTimeout( _.bind(this.checkShouldUnthrottleRead,this), 10000 )
            } else {
                this.checkBuffer()
                this.doRead()
            }
        }
        //this.close('no real reason')
    },
    checkBuffer: function() {
        //console.log('checkBuffer, len', this.readBuffer.deque.length, 'sz', this.readBuffer._size)
        // checks if there are messages
        if (! this.peerHandshake) {
            if (this.readBuffer.size() >= jstorrent.protocol.handshakeLength) {
                var buf = this.readBuffer.consume(jstorrent.protocol.handshakeLength)

                this.handleMessage({type:'HANDSHAKE',payloadSize: buf.byteLength, payload:buf})
                //this.peerHandshake = 
                //if (! this.peerHandshake) {
                //    this.close('invalid handshake')
                //}
                //this.checkBuffer()
            }
        } else {
            // have peer handshake!
            var curbufsz = this.readBuffer.size()
            if (curbufsz >= 4) {
                var msgsize = new DataView(this.readBuffer.consume(4,true)).getUint32(0)
                if (msgsize > jstorrent.protocol.maxPacketSize) {
                    console.error('protocol message too large',msgsize)
                    this.close('message too large')
                } else {
                    if (curbufsz >= msgsize + 4) {
                        var msgbuf = this.readBuffer.consume(msgsize + 4)
                        this.parseMessage(msgbuf)
                        return true
                    }
                }
            }
        }
    },
    parseMessage: function(buf) {
        var data = {}
        //console.log('handling bittorrent message', new Uint8Array(buf))
        var msgsz = new DataView(buf, 0, 4).getUint32(0)
        if (msgsz == 0) {
            data.type = 'KEEPALIVE'
            // keepalive message
        } else {
            data.code = new Uint8Array(buf, 4, 1)[0]
            var messageString = jstorrent.protocol.messageCodes[data.code]
            data.type = messageString
            data.payload = buf
            data.payloadLength = buf.byteLength
        }

        //console.log('Received message',data.type)

        this.handleMessage(data)
    },
    handleMessage: function(msgData) {
        //console.log('handling message',msgData)
        var method = this['handle_' + msgData.type]
        this.set('last_message_received',msgData.type) // TODO - get a more specific message for piece number
        if (! method) {
            this.unhandledMessage(msgData)
        } else {
            method.apply(this,[msgData])
        }
        // once a message is handled, there is new state, so check if
        // we want to write something
        this.newStateThink()
    },
    handle_REQUEST: function(msg) {
        if (this.peerChoked) { 
            //console.log('wont handle request, peer is choked')
            // silently dont handle PIECE requests from choked peers.
            return 
        }
        

        // TODO -- if write buffer is pretty full, don't create diskio
        //job yet, since we want to do it more lazily, not too
        //eagerly.  :-) todo -- make this work better haha

        // parse message
        var header = new DataView(msg.payload, 5, 12)
        var pieceNum = header.getUint32(0)
        var offset = header.getUint32(4)
        var size = header.getUint32(8)
        if (this.torrent.has_infodict() && this.torrent.havePieceData(pieceNum)) {
            this.torrent.registerPieceRequested(this, pieceNum, offset, size)            
        } else {
            // my bitfield may be one off...
            this.sendMessage("REJECT_REQUEST", msg.payload) 
        }

    },
    handle_SUGGEST_PIECE: function(msg) {
        var pieceNum = new DataView(msg.payload, 5, 4).getUint32(0)
        var bit = this.torrent.havePieceData(pieceNum)
        console.log('why are they suggesting piece?',pieceNum,'our bitmask says', bit)
        if (bit == 1) {
            var payload = new Uint8Array(4)
            var v = new DataView(payload.buffer)
            v.setUint32(0,pieceNum)
            this.sendMessage("HAVE", [payload.buffer])
        }
    },
    handle_PIECE: function(msg) {
        this.set('responses',this.get('responses')+1)
        var v = new DataView(msg.payload, 5, 12) // TODO catch error with erroneous size payload (out of bounds)
        var pieceNum = v.getUint32(0)
        var chunkOffset = v.getUint32(4)
        // does not send size, inherent in message. could be smaller than chunk size though!
        var data = new Uint8Array(msg.payload, 5+8)
        console.assert(data.length <= jstorrent.protocol.chunkSize)
        this.torrent.unflushedPieceDataSize += data.byteLength
        //console.log('++increment unflushedPieceDataSize', this.torrent.unflushedPieceDataSize)
        if (! this.torrent.pieces.containsKey(pieceNum)) {
            // we didn't ask for this piece
            //console.log('handle piece, but piece not extant') // happens after a timeout and the piece finishes from another peer
        } else {
            this.torrent.getPiece(pieceNum).registerChunkResponseFromPeer(this, chunkOffset, data)
        }
    },
    handle_UNCHOKE: function() {
        this.set('amChoked',false)
        this.amChoked = false
    },
    handle_CANCEL: function() {
        // ignore this message
    },
    handle_CHOKE: function() {
        this.set('amChoked',true)
        this.amChoked = true
    },
    handle_INTERESTED: function() {
        this.peerInterested = true
        if (this.torrent.isPrivate() || app.options.get('seed_public') || this.peer.host == '127.0.0.1') {
            this.sendMessage('UNCHOKE') // TODO - under what conditions?
        }
    },
    handle_NOT_INTERESTED: function() {
        this.peerInterested = false
    },
    handle_PORT: function(msg) {
        // peer's listening port (DHT)?
        this.peerPort = new DataView(msg.payload, 5, 2).getUint16(0)
        if (app.options.get('debug_dht')) {
            app.dht.ping(this.peer.host, this.peerPort)
        }
    },
    handle_HANDSHAKE: function(msg) {
        var buf = msg.payload
        this.peerHandshake = jstorrent.protocol.parseHandshake(buf)
    },
    handle_KEEPALIVE: function() {
        // do nothin... 
    },
    handle_UTORRENT_MSG: function(msg) {
        // extension message!
        var extType = new DataView(msg.payload, 5, 1).getUint8(0)

        if (extType == jstorrent.protocol.extensionMessageHandshakeCode) {
            // bencoded extension message handshake follows
            this.peerExtensionHandshake = bdecode(ui82str(new Uint8Array(msg.payload, 6)))
            if (this.peerExtensionHandshake.v) {
                this.set('peerClientName',jstorrent.protocol.tweakPeerClientName(this.peerExtensionHandshake.v))
            }
            if (this.peerExtensionHandshake.m) {
                for (var key in this.peerExtensionHandshake.m) {
                    this.peerExtensionHandshakeCodes[this.peerExtensionHandshake.m[key]] = key
                }
            }
        } else if (jstorrent.protocol.extensionMessageCodes[extType]) {
            var extMsgType = jstorrent.protocol.extensionMessageCodes[extType]

            if (extMsgType == 'ut_metadata') {
                this.handle_UTORRENT_MSG_ut_metadata(msg)
            } else if (extMsgType == 'ut_pex') {
                this.handle_UTORRENT_MSG_ut_pex(msg)
            } else {
                //debugger
            }
        } else {
            //debugger
        }
        
    },
    handle_UTORRENT_MSG_ut_pex: function(msg) {
        var data = bdecode(ui82str(new Uint8Array(msg.payload, 6)))
        // TODO -- use this data :-)
        //console.log('ut_pex data', data)
        var idx, host, port, peer
        if (data.added) {
            this.torrent.addCompactPeerBuffer(data.added)
        }
        this.torrent.maybePropagatePEX(data)
    },
    handle_UTORRENT_MSG_ut_metadata: function(msg) {
        var extMessageBencodedData = bdecode(ui82str(new Uint8Array(msg.payload),6))
        //console.log(this.get('address'),'ut_metadata',extMessageBencodedData)
        var infodictCode = extMessageBencodedData.msg_type
        var infodictMsgType = jstorrent.protocol.infodictExtensionMessageCodes[infodictCode]

        if (infodictMsgType == 'DATA') {
            if (this.torrent.infodict_buffer) {
                //console.log('ignoring it, we already received one.')
                return
            }

            // looks like response to metadata request! yay

            var dataStartIdx = bencode(extMessageBencodedData).length;
            var infodictDataChunk = new Uint8Array(msg.payload, 6 + dataStartIdx)
            var infodictChunkNum = extMessageBencodedData.piece

            this.set('last_message_received', 'UT_METADATA '+infodictChunkNum)

            if (this.registeredRequests['infodictRequest'][infodictChunkNum]) {

                this.registeredRequests['infodictRequest'][infodictChunkNum].received = true
                this.infodictResponses[infodictChunkNum] = infodictDataChunk

                var ismissing = false // check if we received everything
                for (var i=0; i<this.infodictResponses.length; i++) {
                    if (this.infodictResponses[i] === null) {
                        //console.log(this.get('address'),'infodict responses was missing chunk',i,'total',this.infodictResponses.length)
                        ismissing = true
                        break
                    }
                }
                if (! ismissing) {
                    // we have everything now! make sure it matches torrent hash
                    this.processCompleteInfodictResponses()
                }
            } else {
                console.error("was not expecting this torrent metadata piece")
            }
        } else if (infodictMsgType == 'REQUEST') {
            if (! this.torrent.infodict_buffer) { return } // cant handle this!

            var code = this.peerExtensionHandshake.m.ut_metadata

            var pieceRequested = extMessageBencodedData.piece

            var d = { msg_type: jstorrent.protocol.infodictExtensionMessageNames.DATA,
                      total_size: this.torrent.infodict_buffer.byteLength, // do we need to send this?
                      piece: pieceRequested }

            var slicea = jstorrent.protocol.chunkSize * pieceRequested
            var slicelen = Math.min( d.total_size - slicea,
                                     jstorrent.protocol.chunkSize )
            // TODO -- assert pieceRequested/slicea in bounds
            var slicebuf = new Uint8Array(this.torrent.infodict_buffer, slicea, slicelen)
            var newbuf = new Uint8Array(slicelen)
            newbuf.set( slicebuf )
            //console.log('sending metadata payload', code, d)
            this.sendMessage("UTORRENT_MSG",
                             [new Uint8Array([code]).buffer,
                              new Uint8Array(bencode(d)).buffer,
                              newbuf.buffer])
        } else {
            //debugger
        }
    },
    sendPEX: function(data) {
        if (this.peerExtensionHandshake) {
            var code = this.peerExtensionHandshake.m.ut_pex
            this.sendMessage("UTORRENT_MSG",
                             [new Uint8Array([code]).buffer,
                              new Uint8Array(bencode(data)).buffer])
            console.log('sent PEX to', this.get('address'))
        }
    },
    processCompleteInfodictResponses: function() {
        var b = new Uint8Array(this.peerExtensionHandshake.metadata_size)
        var idx = 0
        for (var i=0; i<this.infodictResponses.length; i++) {
            b.set( this.infodictResponses[i], idx )
            idx += this.infodictResponses[i].byteLength
        }
        console.assert(idx == this.peerExtensionHandshake.metadata_size)

        // XXX -- not happening in background thread??
        // better to have bdecode that works on arraybuffers?
        var infodict = bdecode(ui82str(b),{utf8:true})
        //var infodict = bdecode(ui82str(b))
        var digest = new Digest.SHA1()
        digest.update(b)
        var receivedInfodictHash = new Uint8Array(digest.finalize())

        if (ui82str(receivedInfodictHash) == ui82str(this.torrent.hashbytes)) {
            console.log("%c Received valid infodict!", 'background:#3f3; color:#fff')
            this.torrent.infodict_buffer = b.buffer
            this.torrent.infodict = infodict
            this.torrent.metadata.info = infodict
            this.torrent.metadataPresentInitialize()
        } else {
            console.error('received metadata does not have correct infohash! bad!')
            this.error('bad_metadata')
        }
    },
    doAfterInfodict: function(msg) {
        //console.warn('Deferring message until have infodict',msg.type)
        this.handleAfterInfodict.push( msg )
    },
    handle_HAVE_ALL: function(msg) {
        if (! this.torrent.has_infodict()) {
            this.doAfterInfodict(msg)
        } else {
            //console.log('handling HAVE_ALL')
            if (! this.peerBitfield) {
                var arr = []
                for (var i=0; i<this.torrent.numPieces; i++) {
                    arr.push(1)
                }
                // it would be cool to use an actual bitmask and save
                // some space. but that's silly :-)
                this.peerBitfield = new Uint8Array(arr)
            } else {
                for (var i=0; i<this.torrent.numPieces; i++) { // SHITTY
                    this.peerBitfield[i] = 1
                }
            }
        }
        this.updatePercentComplete()
    },
    sendBitfield: function() {
        // XXX this may have some errors... seems to be off by one?
        this.sentBitfield = true
        var maxi = Math.ceil(this.torrent.numPieces/8)
        var arr = []
        var curByte
        var idx

        for (var i=0; i<maxi; i++) {
            curByte = 0
            idx = 8*i
            for (var j=7; j>=0; j--) {
                if (idx < this.torrent.numPieces) {
                    curByte = (curByte | (this.torrent.havePieceData(idx) << j))
                }
                idx++
            }
            //console.assert(curByte >= 0 && curByte < 256)
            arr.push(curByte)
        }
        this.sendMessage('BITFIELD',[new Uint8Array(arr).buffer])
    },
    handle_BITFIELD: function(msg) {
        if (! this.torrent.has_infodict()) {
            this.doAfterInfodict(msg)
        } else {
            var bitfield = new Uint8Array(msg.payload, 5)
            var arr = jstorrent.protocol.parseBitfield(bitfield, this.torrent.numPieces)
            // it would be cool to use an actual bitmask and save
            // some space. but that's silly :-)
            this.peerBitfield = new Uint8Array(arr)
            //console.log('set peer bitfield', Torrent.attributeSerializers.bitfield.serialize(ui82arr(this.peerBitfield)))
            console.assert(this.peerBitfield.length == this.torrent.numPieces)
        }
        this.updatePercentComplete()
    },
    handle_HAVE: function(msg) {
        if (! this.torrent.has_infodict()) {
            this.doAfterInfodict(msg)
        } else {
            var idx = new DataView(msg.payload,5,4).getUint32(0)
            if (! this.peerBitfield) {
                // not sure why clients would do this...
                this.peerBitfield = new Uint8Array(this.torrent.numPieces)
            }
            this.peerBitfield[idx] = 1
        }
        this.updatePercentComplete()
    },
    unhandledMessage: function(msg) {
        console.error('unhandled message',msg.type)
        //debugger
    }
}

for (var method in jstorrent.Item.prototype) {
    jstorrent.PeerConnection.prototype[method] = jstorrent.Item.prototype[method]
}
