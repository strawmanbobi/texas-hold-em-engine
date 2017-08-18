/**
 * Created by jieping on 2017/7/22.
 */
var WebSocketServer = require('ws').Server;
var UUID = require('node-uuid');
var events = require('events');
var util = require('util');
var poker = require('./node-poker');


var errorCb = function (rtc) {
    return function (error) {
        if (error) {
            rtc.emit("error", error);
        }
    };
};

function SkyRTC() {
    this.table = [];
    this.admin = null;
    this.players = {};
    this.tablePlayerNumber = 3;
    this.playerNumber = 0;
    this.on('__join', function (data, socket) {
        var that = this;
        var playerName = data.playerName;
        if (playerName)
            socket.id = playerName;

        if (playerName == 'admin')
            that.admin = socket;
        else {
            that.playerNumber++;
            that.players[socket.id] = socket;
        }
        this.emit('new_peer', socket.id);
        that.notificationAdmin();
    });

    this.on('_startGame', function () {
        this.startGame();
    });

    this.on('_action', function (data) {
        console.log("用户" + data.playerName + "采取动作" + data.action);
        var that = this;
        var action = data.action;
        var playerName = data.playerName;
        var tableNum = that.players[playerName].tableNumber;
        var currentTable = that.table[tableNum];
        if (currentTable.timeout)
            clearTimeout(currentTable.timeout);
        var playerIndex = parseInt(getPlayerIndex(playerName, currentTable.players));
        if (playerIndex != currentTable.currentPlayer)
            currentTable.players[playerIndex].Fold();
        else if (playerIndex != -1 && currentTable.checkPlayer(playerIndex)) {
            switch (action) {
                case "Bet":
                    if (currentTable.isBet) {
                        try {
                            var amount = parseInt(data.amount.replace(/(^\s*)|(\s*$)/g, ""));
                            currentTable.players[playerIndex].Bet(amount);
                        } catch (e) {
                            console.log(e.message);
                            currentTable.players[playerIndex].Fold();
                        }
                    } else
                        currentTable.players[playerIndex].Call();
                    break;
                case "Call":
                    if (currentTable.isBet)
                        currentTable.players[playerIndex].Bet(currentTable.smallBlind);
                    else
                        currentTable.players[playerIndex].Call();
                    break;
                case "Check":
                    currentTable.players[playerIndex].Check();
                    break;
                case "Raise":
                    if (currentTable.isBet)
                        currentTable.players[playerIndex].Bet(currentTable.smallBlind);
                    else
                        currentTable.players[playerIndex].Raise();
                    break;
                case "All-in":
                    if (currentTable.isBet)
                        currentTable.isBet = false;
                    currentTable.players[playerIndex].AllIn();
                    break;
                case "Fold":
                    currentTable.players[playerIndex].Fold();
                    break;
                default:
                    currentTable.players[playerIndex].Fold();
                    break;
            }


        }
    });
}

util.inherits(SkyRTC, events.EventEmitter);

function getPlayerIndex(playerName, players) {
    for (var i in players) {
        var player = players[i];
        if (player.playerName == playerName)
            return i;
    }
    return -1;
}

SkyRTC.prototype.notificationAdmin = function () {
    var that = this;
    if (that.admin) {
        var players = [];
        for (var playerName in that.players)
            players.push(playerName);
        var message = {
            "eventName": "_new_peer",
            "data": players
        }
        that.admin.send(JSON.stringify(message), errorCb);
    }
}

SkyRTC.prototype.startGame = function () {
    var that = this;
    var message;
    var playerNum = parseInt(that.playerNumber);
    var tablePlayerNum = parseInt(that.tablePlayerNumber);
    var tableNum = playerNum % tablePlayerNum == 0 ? parseInt(playerNum / tablePlayerNum) : parseInt(playerNum / tablePlayerNum) + 1;
    that.table.splice(0, that.table.length);
    for (var i = 0; i < tableNum; i++)
        that.table.push(new poker.Table(50, 100, 3, 10, 100, 1000));
    that.initTable();
    var index = 0;
    for (var player in this.players) {
        var belongTable = parseInt(index / tablePlayerNum);
        that.table[belongTable].AddPlayer(player);
        that.players[player].tableNumber = belongTable;
        index++;
    }
    for (var i = 0; i < that.table.length; i++) {
        if (that.table[i].playersToAdd.length < that.table[i].minPlayers) {
            console.log(that.table);
            message = {
                "eventName": "startGame",
                "data": {"msg": "table " + i + " need at least " + that.table.minPlayers + " users to attend"}
            }
        } else {
            that.table[i].StartGame();
            message = {
                "eventName": "startGame",
                "data": {"msg": "table " + i + " start successfully"}
            }
        }
        if (that.admin)
            that.admin.send(JSON.stringify(message), errorCb);
    }

}

SkyRTC.prototype.initTable = function () {
    var that = this;
    for (var i = 0; i < that.table.length; i++) {
        that.table[i].tableNumber = i;
        that.table[i].eventEmitter.on("__turn", function (data) {
            var message = {
                "eventName": "__action",
                "data": data
            }
            that.getPlayerAction(message);
        });

        that.table[i].eventEmitter.on("__bet", function (data) {
            var message = {
                "eventName": "__bet",
                "data": data
            }
            that.getPlayerAction(message);
            var message2 = {
                "eventName": "__deal",
                "data": {"data": data.game.board, "tableNumber": data.tableNumber}
            }
            that.admin.send(JSON.stringify(message2), errorCb);
        });

        that.table[i].eventEmitter.on("__gameOver", function (data, tableNumber) {
            var message = {
                "eventName": "__gameOver",
                "data": {"winners": data, "tableNumber": tableNumber}
            }
            that.admin.send(JSON.stringify(message), errorCb);
        });

        that.table[i].eventEmitter.on("__newRound", function (data, tableNumber) {
            var message = {
                "eventName": "__newRound",
                "data": {"roundCount": data, "tableNumber": tableNumber}
            }
            that.admin.send(JSON.stringify(message), errorCb);
        });

        that.table[i].eventEmitter.on("_showAction", function (data, tableNumber) {
            var message = {
                "eventName": "__showAction",
                "data": {"data": data, "tableNumber": tableNumber}
            }
            that.admin.send(JSON.stringify(message), errorCb);
            that.broadcastInPlayers(message);
        });
    }
}

SkyRTC.prototype.getPlayerAction = function (message) {
    var that = this;
    var player = message.data.player.playerName;
    var tableNumber = that.players[player].tableNumber;
    var currentTable = that.table[tableNumber];
    console.log("服务端轮询动作：" + JSON.stringify(message));
    if (player) {
        that.players[player].send(JSON.stringify(message), errorCb);
        /* currentTable.timeout = setTimeout(function () {
         console.log("用户" + currentTable.players[currentTable.currentPlayer].playerName + "超时，自动放弃");
         currentTable.players[currentTable.currentPlayer].Fold();
         }, 5000);*/
    }
};

SkyRTC.prototype.removeSocket = function (socket) {
    var id = socket.id;
    var that = this;
    delete that.players[id];
};

SkyRTC.prototype.broadcastInPlayers = function (data) {
    for (var player in this.players) {
        this.players[player].send(JSON.stringify(data), errorCb);
    }
};


SkyRTC.prototype.init = function (socket) {
    var that = this;
    socket.id = UUID.v4();

    //为新连接绑定事件处理器
    socket.on('message', function (data) {
        var json = JSON.parse(data);
        if (json.eventName) {
            that.emit(json.eventName, json.data, socket);
        } else {
            that.emit("socket_message", socket, data);
        }
    });
    //连接关闭后从SkyRTC实例中移除连接，并通知其他连接
    socket.on('close', function () {

        that.emit('remove_peer', socket.id);
        that.removeSocket(socket);

    });
    that.emit('new_connect', socket);
};

exports.listen = function (server) {
    var SkyRTCServer;
    if (typeof server === 'number') {
        SkyRTCServer = new WebSocketServer({
            port: server
        });
    } else {
        SkyRTCServer = new WebSocketServer({
            server: server
        });
    }

    SkyRTCServer.rtc = new SkyRTC();
    errorCb = errorCb(SkyRTCServer.rtc);
    SkyRTCServer.on('connection', function (socket) {
        this.rtc.init(socket);
    });

    return SkyRTCServer;
};