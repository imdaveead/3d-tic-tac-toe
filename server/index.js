// This file is the entry point, use it to start up all services
const fs = require('fs');
const path = require('path');
const chalk = require('chalk');
const uuidv4 = require('uuid/v4');
const doTheWinDetect = require("../game/win-detect");

// process.c(path.join(__dirname, "../"));

// Write a default .ENV if one does not exist
if (!fs.existsSync(".env")) {
    let dotenvdata = "# Application Configuration File\n"
                    + "HTTP_PORT=80\n"
                    + "HTTPS_PORT=false\n"
                    + "HTTPS_KEY=keys/private.key\n"
                    + "HTTPS_CERT=keys/certificate.crt\n"
                    + "STATIC_FOLDER=game\n"

    fs.writeFileSync(".env", dotenvdata);
    console.log(chalk.yellow("A default .env file was created, use this to configure the application."))
}

// Load .ENV file
require('dotenv').config();

// Start the express server
const express = require('express');
const app = express();
const io = require('socket.io')();

app.use(express.static(path.join(__dirname, "../", process.env.STATIC_FOLDER), {
    // maxAge: "12h"
    maxAge: "0s"
}));

const sockets = {};
const rooms = {};

function makeid() {
    var text = "";
    var possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

    for (var i = 0; i < 5; i++)
        text += possible.charAt(Math.floor(Math.random() * possible.length));

    return text;
}

const ensureTypeData = {
    "not undefined": (x) => typeof x !== "undefined",
    "string": (x) => typeof x === "string",
    "number": (x) => typeof x === "number",
    "boolean": (x) => typeof x === "boolean",
    "object": (x) => typeof x === "object" && x !== null,
    "array": (x) => Array.isArray(x),
}

function is(input, type) {
    return ensureTypeData[type](input);
}

function ensure(bool, reason, socket) {
    if(!bool) {
        console.log("Kicked: " + chalk.red(reason || "<no reson set>"));

        if(reason.startsWith("[recover]")) {
            socket.emit("recover failed");
            setTimeout(() => {
                socket.disconnect();
            }, 500);
        } else {
            socket.disconnect();
        }
    }
    return !bool;
}

function SocketToPlayer(socket) {
    if(socket.missing) {
        return {
            id: socket.id,
            name: socket.name,
            missing: true,
            // secret: socket.secret,
        }
    } else {
        return {
            id: socket.id,
            name: socket.name,
            missing: false,
            // secret: socket.secret
        }
    }
}

function joinRoom(socket, room) {
    // hard coded "#full" room, you cannot join this, as it always
    // "is full"
    if(room === "full") {
        socket.emit("room too big");
        socket.disconnect();
        return;
    }

    //create a room if needed
    if(!(room in rooms)) {
        rooms[room] = {
            players: [],
            state: "lobby",
            id: room,
            leader: socket,
            isStarted: false,
        };
        socket.emit("youre leader");
    } else {
        socket.emit("youre not leader");
    }

    // if room is too big notify
    if (rooms[room].players.length >= 4) {
        socket.emit("room too big");
        socket.disconnect();
        return;
    }

    // if room is started, failll
    if (rooms[room].isStarted) {
        socket.emit("room started :(");
        socket.disconnect();
        return;
    }

    // notify
    rooms[room].players.forEach(sock => {
        if (!sock.missing)
            sock.emit("player join", SocketToPlayer(socket));
    });

    // send player list
    socket.emit("join info", rooms[room].players.length, rooms[room].players.map(SocketToPlayer));

    // add
    rooms[room].players.push(socket);

}
function notifyRoomOfName(socket, room, name) {
    // notify
    rooms[room].players.forEach(sock => {
        if(sock === socket) { return; };
        if (!sock.missing)
            sock.emit("player name set", socket.id, name);
    });
}
function leaveRoom(socket, room) {
    // ignore if room is gone
    if(!(room in rooms)) return;

    // if in a game, we need to do some other logic
    if (rooms[room].isStarted) {
        rooms[room].players = rooms[room].players.map(x => {
            if(x.id === socket.id) {
                return { missing: true, name: socket.name, id: socket.id, secret: socket.secret };
            } else {
                return x;
            }
        });
        
    } else {
        // lobby

        // remove
        rooms[room].players = rooms[room].players.filter(x => x.id !== socket.id);
        
        // notify
        rooms[room].players.forEach((sock, index) => {
            if (sock === socket) { return; };
            if(!sock.missing)
                sock.emit("player leave", socket.id, index);
        });
        
        // if empty destroy room
        if(rooms[room].players.length === 0) {
            delete rooms[room];
        } else {
            // dont reassign leader if non lobby
            if(rooms[room].isStarted) {
                return;
            }
    
            // reassign leader
            if(socket.id === rooms[room].leader.id) {
                rooms[room].leader = rooms[room].players[0];
                rooms[room].leader.emit("youre leader");
            }
        }
    }

}
function attemptRejoinRoom(socket, recoverData) {
    // ignore if room is gone
    if (!(recoverData.room in rooms)) {
        socket.emit("recover failed");
        return console.log("[recover] no room exist");
    }

    // if room lobby, we tell them so
    if (!rooms[recoverData.room].isStarted) {
        socket.emit("recover failed");
        return console.log("[recover] room is in lobby state");
    }
    // if room ended, we tell them so
    if (rooms[recoverData.room].isEnded) {
        socket.emit("recover failed");
        return console.log("[recover] room is ended state");
    }

    // find the player in the room
    var index = -1;

    rooms[recoverData.room].players.forEach((player, i) => {
        if (player.missing && player.id === recoverData.id && player.secret === recoverData.secret) {
            index = i;
        };
    });

    if(index === -1) {
        socket.emit("recover failed");
        return console.log("[recover] cannot find a match");
    }

    // found a match, add magic
    rooms[recoverData.room].players[index] = socket;

    socket.emit("recover success", {
        turn: rooms[recoverData.room].turn,
        map: rooms[recoverData.room].map,
        players: rooms[recoverData.room].players.map(SocketToPlayer).filter(x => x.id !== socket.id),
        index,
        id: recoverData.id,
        secret: recoverData.secret
    });

    return true;
}


function startRoom(socket, room) {
    // ignore if room is gone
    if (!(room in rooms)) return console.log("[start] no room exist");
    
    // ignore if room started
    if (rooms[room].isStarted) return console.log("[start] started");
    
    // ignore if not leader
    if (rooms[room].leader.id !== socket.id) return console.log("[start] no leader");

    // ignore if room is less than 2
    if (rooms[room].players.length < 2) return console.log("[start] room size");

    rooms[room].isStarted = true;
    rooms[room].players.forEach(sock => {
        if(!sock.missing)
            sock.emit("game is about to start");
    });

    rooms[room].map = [...Array(3)].map(x => [...Array(3)].map(x => [...Array(3)].map(x => -1)));
    rooms[room].turn = 0;
    rooms[room].isEnded = false;
}
function paintCube(socket, room, position) {
    // ignore if room is gone
    if (!(room in rooms)) return console.log("[paintCube] no room exist");

    // ignore if room not started
    if (!rooms[room].isStarted) return console.log("[paintCube] not started");

    // index
    var index = 0;

    rooms[room].players.forEach((sock, i) => {
        if (sock === socket) {
            index = i;
            return;
        };
    });

    // ignore if not turn
    if(rooms[room].turn !== index) return console.log("[paintCube] not turn");

    // ignore if taken
    let x = position[0];
    let y = position[1];
    let z = position[2];
    if(rooms[room].map[x][y][z] !== -1) return console.log("[paintCube] taken");

    // set the block
    rooms[room].map[x][y][z] = index;

    // push turn up
    rooms[room].turn = (rooms[room].turn + 1) % (rooms[room].players.length);

    // win detec
    const winner = doTheWinDetect(rooms[room].map);
    if (winner[0] !== null) {
        // reset room.
        rooms[room].isStarted = false;
        delete rooms[room].map
        delete rooms[room].turn;
        delete rooms[room].isEnded;
    }

    // notify
    rooms[room].players.forEach(sock => {
        if (sock === socket) { return; };
        if (!sock.missing)
            sock.emit("paint", position, index);
    });
}

io.on("connection", (socket) => {
    // give them a uuid and a name
    socket.id = uuidv4();
    socket.secret = uuidv4();
    socket.name = null;
    
    // store in the unused socket list :)
    sockets[socket.id] = socket;

    var room = null;

    // binding ensure to the socket
    // if we pass a false value to <bool> the socket is kicked for <reason>, logged to console for debug purpose.
    var T = (bool, reason) => ensure(bool, reason, socket);

    socket.emit("socket code", socket.id, socket.secret);

    socket.on("join room", (newroom) => {
        // newroom: string(a-z and 0-9, max 8 chars)
        if(0
            || T(room === null, "[join room] Already in a room")
            || T(is(newroom, "string"), "[join room] Invalid Type")
            || T(newroom.length <= 8, "[join room] Invalid Length")
            || T(/[^a-zA-Z0-9]/.exec(newroom) === null, "[join room] Invalid Chars")
        ) return socket.disconnect();

        room = newroom;

        joinRoom(socket, room);
    });
    socket.on("name entry", (newname) => {
        // newname: string(length 2-12, specific character)
        if(0
            || T(socket.name === null, "[name entry] Name Already Set")
            || T(is(newname, "string"), "[name entry] Invalid Type")
            || T(newname.length >= 2, "[name entry] Invalid Length")
            || T(newname.length <= 12, "[name entry] Invalid Length")
            || T(/[^a-zA-Z0-9  '"]/.exec(newname) === null, "[name entry] Invalid Characters")
        ) return;

        socket.name = newname;

        if(room) {
            notifyRoomOfName(socket, room, socket.name);
        }
    });
    socket.on("start game", () => {
        if(room) {
            startRoom(socket, room);
        }
    });
    socket.on("disconnect", () => {
        if(room) leaveRoom(socket, room);

        delete sockets[socket.id];
    });
    socket.on("paint", (pos) => {
        // pos: array[number,number,number], numbers must be 0-2
        if (0
            || T(room !== null, "[paint] not in room")
            || T(is(pos, "array"), "[paint] position not array")
            || T(is(pos[0], "number"), "[paint] position not number")
            || T(is(pos[1], "number"), "[paint] position not number")
            || T(is(pos[2], "number"), "[paint] position not number")
            || T(pos[0] >= 0, "[paint] position not number")
            || T(pos[0] <= 2 , "[paint] position not number")
            || T(pos[1] >= 0, "[paint] position not number")
            || T(pos[1] <= 2 , "[paint] position not number")
            || T(pos[2] >= 0, "[paint] position not number")
            || T(pos[2] <= 2 , "[paint] position not number")
        ) return;
        
        paintCube(socket, room, pos);
    });
    socket.on("recover me", (recoverPayload) => {
        if(0
            || T(typeof recoverPayload === "object","[recover] not an object")
            || T(!Array.isArray(recoverPayload),"[recover] not an object")
            || T(recoverPayload !== null,"[recover] not an object")
            || T(typeof recoverPayload.id === "string", "[recover] bad type: recoverData.id")
            || T(typeof recoverPayload.room === "string", "[recover] bad type: recoverData.room")
            || T(typeof recoverPayload.name === "string", "[recover] bad type: recoverData.name")
            || T(Array.isArray(recoverPayload.players), "[recover] bad type: recoverData.players")
            || T(!recoverPayload.players.find(player => {
                // return a bad only
                if(typeof player !== "object") return true;
                if(player === null) return true;
                if(Array.isArray(player)) return true;
                if(typeof player.id !== "string") return true;
                if(typeof player.name !== "string") return true;

                return false;
            }), "[recover] bad type: recoverData.players")
            || T(Array.isArray(recoverPayload.map), "[recover] bad type: recoverData.map")
            || T(typeof recoverPayload.index === "number", "[recover] bad type: recoverData.index")
        ) return;
        
                    
        if (attemptRejoinRoom(socket, recoverPayload)) {
            socket.id = recoverPayload.id;
            socket.name = recoverPayload.name;
            socket.secret = recoverPayload.secret;
            room = recoverPayload.room;
        }

    });
});

// route to get an empty room id, just in case.
app.get("/empty-room", (req,res) => {
    let id;

    do {
        id = makeid();
    } while (id in rooms);

    res.send(id);
});

///////////////////////////////////////////////////////////////////////////
// make the servers actually run

if (isNaN(parseInt(process.env.HTTP_PORT)) && isNaN(parseInt(process.env.HTTPS_PORT))) {
    console.log(chalk.red("No HTTP or HTTPS server configured! How else are you gonna play the game!?"));
    console.log(chalk.red("Please configure the .env file to start at least one server on a port."));
    return;
}
if (parseInt(process.env.HTTP_PORT) === parseInt(process.env.HTTPS_PORT)) {
    console.log(chalk.red("HTTP and HTTPS on the same port!? We can't do that!"));
    console.log(chalk.red("Please configure the .env file to start the two servers on different ports, or disable one."));
    return;
}

// HTTP
if (!isNaN(parseInt(process.env.HTTP_PORT))) {
    const server = require('http').Server(app);
    server.listen(parseInt(process.env.HTTP_PORT), function () {
        console.log('HTTP Enabled.  ' + chalk.blue(`http://localhost:${process.env.HTTP_PORT}/`));
    });
    io.attach(server);
}

// HTTPS
if (!isNaN(parseInt(process.env.HTTPS_PORT))) {
    var server = require('https').createServer({
        key: fs.readFileSync(process.env.HTTPS_KEY),
        cert: fs.readFileSync(process.env.HTTPS_CERT),
    }, app);
    server.listen(parseInt(process.env.HTTPS_PORT), function () {
        console.log('HTTPS Enabled. ' + chalk.blue(`https://localhost:${process.env.HTTPS_PORT}/`));
    });
    io.attach(server);
}
