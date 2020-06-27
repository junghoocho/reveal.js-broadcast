/**
 * A plugin that adds fragment class to top-level elements of each slide
 *
 * @author Junghoo Cho at UCLA
 */

class BroadCastPlugIn {
    constructor() {
        // plugin ID
        this.id = 'broadcast';
        // default plugin options
        this.options = {
            socketJs: "https://cdnjs.cloudflare.com/ajax/libs/socket.io/2.2.0/socket.io.js",
            eventDispatchDelay: 100,
            stateDispatchDelay: 500,
            remoteStateChangeBlackout: 2000,
        };

        this.socket = null;
    
        // state-change-event message queue
        this.lastStateChange = 0;
        this.stateDispatchTimer = null;
        this.lastSharedState = null;
        this.lastRemoteStateChange = 0;

        // custom-event message queue
        this.lastEventDispatch = 0;
        this.eventDispatchTimer = null;
        this.eventQueue = [];
    }

    // load javascript from url and invoke callback
    loadJavaScript(url, callback) {
        // document head where script will be inserted
		let head = document.getElementsByTagName('head')[0];

		// load the JS
		let script = document.createElement('script');
        script.type = 'text/javascript';
        if (script.readyState) {  // for IE < 9
            script.onreadystatechange = (() => {
                if (script.readyState === "loaded" || script.readyState === "complete") {
                    script.onreadystatechange = null;
                    callback();
                }
            });
        } else {
            script.onload = (() => { callback(); });
        }
		script.src = url;
		head.appendChild(script);
    }

    isEquivalent(s1, s2) {
        return (s1.indexh === s2.indexh && s1.indexv === s2.indexv && s1.indexf === s2.indexf && s1.paused === s2.paused);
    }

    dispatchStateChange(state) {
        let messageData = {
            secret: this.options.secret,
            socketId: this.options.socketId,
            state: state,
        };
        this.lastSharedState = {...state};
        this.socket.emit( 'multihost-statechanged', messageData );
    }

    handleStateChange() {
        let state = this.deck.getState();
        let now = Date.now();

        // post state change message only if current state is different from the last state shared over the network
        if (this.lastSharedState && this.isEquivalent(state, this.lastSharedState)) return;

        // if we are within the black-out period of a remotely-initiated state change,
        // we don't share out state change with others
        // this is a "hack" to avoid an "echo chamber" effect, 
        // where simultaneous state changes initiated by two device "ping-pong"s forever
        let interval = now - this.lastRemoteStateChange;
        if (interval < this.options.remoteStateChangeBlackout) return;

        // check if stateDispatchDelay ms has passed since the last state change
        interval = now - this.lastStateChange;
        if (interval >= this.options.stateDispatchDelay) { 
            // enough time has passed since last state change, so we want to share our current state;
            // since we are sharing our latest state, we can clear-out any pending state-sharing message
            this.dispatchStateChange(state);
        } else {
            // state-changes are being triggered too frequently
            // set a timer to wait for stateDispatchDelay to see if things calm down

            // if there is any pending timer, clear it because we are setting a new one now
            if (this.stateDispatchTimer)  clearTimeout(this.stateDispatchTimer);

            // set a new timer to share the current state after stateDispatchDelay
            this.stateDispatchTimer = setTimeout(() => { 
                this.stateDispatchTimer = null;
                this.dispatchStateChange(state);
            }, this.options.stateDispatchDelay);
        }
        this.lastStateChange = now;
    }

    dispatchEventQueue() {
        if (this.eventQueue.length > 0) {
            let events = this.eventQueue;
            this.eventQueue = [];
            this.socket.emit( 'multihost-statechanged', {
                secret: this.options.secret,
                socketId: this.options.socketId,
                events: events,
            });
            this.lastEventDispatch = Date.now();
        }
    }

    handleCustomEvent(data) {
        // add the new custom event to the event dispatch queue
        this.eventQueue.push(data.content);

        // check if eventDispatchDelay ms has passed since the last event dispatch
        let interval = Date.now() - this.lastEventDispatch;
        if (interval >= this.options.eventDispatchDelay) {
            // enough time has passed. dispatch the event queue now
            this.dispatchEventQueue();
        } else {
            // too many custom events are being triggered in a short time
            // set a timer to dispatch them in batches every eventDispatchDelay ms
            if (!this.eventDispatchTimer) {
                this.eventDispatchTimer = setTimeout(() => { 
                    this.eventDispatchTimer = null;
                    this.dispatchEventQueue(); 
                }, this.options.eventDispatchDelay - interval);
            }
        }
    }

    handleReceivedMessage(data) {
        // ignore data that aren't ours 
        if (data.socketId !== this.options.socketId) return;

        if (data.state) {
            this.lastSharedState = {...data.state};
            this.lastRemoteStateChange = Date.now();
            this.deck.setState(data.state);
        }
        if (data.events) {
            for (let content of data.events) {
                // forward custom events to other plugins
                let event = new CustomEvent('received');
                event.content = content;
                document.dispatchEvent( event );
            }
        }
    }

    setupMaster() {
        // post once the page is loaded, so the client follows also on "open URL".
        window.addEventListener( 'load', () => { this.handleStateChange(); } );

        // Monitor events that trigger a change in state
        this.deck.on( 'slidechanged', () => { this.handleStateChange(); } );
        this.deck.on( 'fragmentshown', () => { this.handleStateChange(); } );
        this.deck.on( 'fragmenthidden', () => { this.handleStateChange(); } );
        this.deck.on( 'paused', () => { this.handleStateChange(); } );
        this.deck.on( 'resumed', () => { this.handleStateChange(); } );

        // Monitor custom events by plugins
        document.addEventListener( 'send', (event) => { this.handleCustomEvent(event); } );
    }

    setupClient() {
        this.socket.on(this.options.socketId, (data) => { this.handleReceivedMessage(data); });
    }

    init(reveal) {
        // save reveal to deck
        this.deck = reveal;
        this.setupFinished = false;

        // get user-provided configuration options
        if (reveal.getConfig()[this.id]) {
            Object.assign(this.options, reveal.getConfig()[this.id]); 
        }

        // if no socketId is set, we cannot use this plugin
        if (this.options.socketId === undefined) return;

        this.loadJavaScript(this.options.socketJs, () => {
            this.socket = io(this.options.socketUrl);
            this.socket.on('connect', () => {
                // make sure we don't run initialization code multiple times
                // without this check, whenever the connection is reestablished
                // due to interruption, it will run again, causing multiple client-server connection
                // and duplicate messages
                if (this.setupFinished) return;

                // if secret is set, set up master broadcaster
                if (this.options.secret) {
                    this.setupMaster();
                }

                // setup event listener if client is true
                if (this.options.socketId) {
                    this.setupClient();
                }

                this.setupFinished = true;
            });
        });
    }
};

/* Reveal.js plugin API:
   (1) The plugin js file must create one global object
   (2) The global object should be (a function that returns) 
       an object with `id` property (of string type)
       and optionally `init` property (of function type)
   (3) The global object's name will be listed in the `plugins: [ ... ]`
       property during slide deck initialization
   (4) The object's `id` is the "key" the plugin is registered with
   (5) If exists, the `init` method will be called as part of the slide 
       initialization process
   (6) If the `init` method returns a promise, the slide "ready" event 
       is fired only after the promise resolves

   The global variable RevealBroadCast will be the plugin's global object.
   If RevealBroadCast already exists, we don't need to do anything */

window.RevealBroadCast = window.RevealBroadCast || new BroadCastPlugIn(); 
