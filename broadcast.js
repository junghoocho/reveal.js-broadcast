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
            master: true, 
            client: true,
            socketJs: "https://cdnjs.cloudflare.com/ajax/libs/socket.io/2.2.0/socket.io.js",
            dispatchDelay: 100,
        };

        this.socket = null;
        this.lastMsgState = null;

        // custom event message queue
        this.lastDispatch = 0;
        this.timeoutSet = false;
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

    isEquivalent(a, b) {
        // Create arrays of property names
        let aProps = Object.getOwnPropertyNames(a);
        let bProps = Object.getOwnPropertyNames(b);
    
        // If number of properties is different,
        // objects are not equivalent
        if (aProps.length != bProps.length) {
            return false;
        }
    
        for (var i = 0; i < aProps.length; i++) {
            var propName = aProps[i];
    
            // If values of same property are not equal,
            // objects are not equivalent
            if (a[propName] !== b[propName]) {
                return false;
            }
        }
    
        // If we made it this far, objects
        // are considered equivalent
        return true;
    }

	handleStateChange() {
        if (!this.lastMsgState || !this.isEquivalent(this.deck.getState(), this.lastMsgState)) {
            let messageData = {
                secret: this.options.secret,
                socketId: this.options.socketId,
                state: this.deck.getState(),
            };
            this.lastMsgState = {...this.deck.getState()};
            this.socket.emit( 'multiplex-statechanged', messageData );
            // console.log("state change msg posted " + JSON.stringify(messageData.state)); 
        }
    }

    postEventQueue() {
        if (this.eventQueue.length > 0) {
            let events = this.eventQueue;
            this.eventQueue = [];
            this.socket.emit( 'multiplex-statechanged', {
                secret: this.options.secret,
                socketId: this.options.socketId,
                events: events,
            });
            this.lastDispatch = Date.now();
            // console.log("custom event msg posted");
        }
    }

    handleCustomEvent(data) {
        this.eventQueue.push(data.content);

        // queue custom events for dispatchDelay
        let interval = Date.now() - this.lastDispatch;
        if (interval >= this.options.dispatchDelay) {
            this.postEventQueue();
        } else {
            // multiple custom events within dispatchDelay
            // debounce the events by setting a timeout event
            if (!this.timeoutSet) {
                this.timeoutSet = true;
                setTimeout(() => { 
                    this.timeoutSet = false;
                    this.postEventQueue(); 
                }, this.options.dispatchDelay - interval);
            }
        }
    }

    handleReceivedMessage(data) {
        // ignore data from sockets that aren't ours 
        if (data.socketId !== this.options.socketId) return;

        if (data.state) {
            // console.log("state change msg received");
            this.lastMsgState = {...data.state};
            this.deck.setState(this.lastMsgState);
        }
        if (data.events) {
            // console.log("custom event msg received" + JSON.stringify(data.events));
            for (let content of data.events) {
                // forward custom events to other plugins
                let event = new CustomEvent('received');
                event.content = content;
                document.dispatchEvent( event );
            }
        }
    }

    setupMaster() {
        // console.log("Setting up as a master for socketID " + this.options.socketId);
        // post once the page is loaded, so the client follows also on "open URL".
        window.addEventListener( 'load', () => { this.handleStateChange(); } );

        // Monitor events that trigger a change in state
        this.deck.on( 'slidechanged', () => { this.handleStateChange(); } );
        this.deck.on( 'fragmentshown', () => { this.handleStateChange(); } );
        this.deck.on( 'fragmenthidden', () => { this.handleStateChange(); } );
        this.deck.on( 'overviewhidden', () => { this.handleStateChange(); } );
        this.deck.on( 'overviewshown', () => { this.handleStateChange(); } );
        this.deck.on( 'paused', () => { this.handleStateChange(); } );
        this.deck.on( 'resumed', () => { this.handleStateChange(); } );
        document.addEventListener( 'send', (event) => { this.handleCustomEvent(event); } );
    }

    setupClient() {
        // console.log("Setting up as a client for socketID " + this.options.socketId);
        this.socket.on(this.options.socketId, (data) => { this.handleReceivedMessage(data); });
    }

    init(reveal) {
        // save reveal to deck
        this.deck = reveal;

        // get user-provided configuration options
        if (reveal.getConfig()[this.id]) {
            Object.assign(this.options, reveal.getConfig()[this.id]); 
        }

        this.loadJavaScript(this.options.socketJs, () => {
            this.socket = io.connect(this.options.socketUrl);

            // setup event broadcaster if master is true
            if (this.options.master && !window.location.search.match(/receiver/gi)) {
                this.setupMaster();
            }

            // setup event listener if client is true
            if (this.options.client) {
                this.setupClient();
            }
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
