require('dotenv').config();

const express = require('express');
const cors = require('cors');
const https = require("https");
const fs = require("fs");
const bodyParser = require('body-parser');
const mysql = require('mysql2/promise');
const { ExpressPeerServer } = require("peer");
const { Server } = require("socket.io");

const auth = require('./auth');

const connection = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USERNAME,
    password: process.env.DB_PASSWORD,
    database: process.env.DB,
    dateStrings: true
});

const port = process.env.PORT || 3000;

const app = express()
    .use(cors({
        origin: "*"
    }))
    .use(bodyParser.json())
    .use(express.static('public'));

app.post("/login", async (req, res) => {
    let { email, password } = req.body;
    const sql_query = "SELECT id_persona, mail FROM persona WHERE mail = ? AND password = ?";

    connection.query(sql_query, [email, password]).then(([rows]) => {
        if (rows.length > 0) {
            let payload = { email: rows[0].mail, id: rows[0].id_persona };
            let token = auth.signToken(payload);

            res.status(200).send({ token: token, expiresIn: 3600 });
        } else {
            res.status(404).send();
        }
    });

});

app.get("/user", auth.authenticateToken, (req, res) => {
    const sql_query = "SELECT nome, cognome, id_persona, mail FROM persona WHERE mail = ?";
    connection.query(sql_query, [req.payload.email]).then(([rows]) => {
        if (rows.length > 0) {
            res.status(200).send({ nome: rows[0].nome, cognome: rows[0].cognome, id_persona: rows[0].id_persona, email: rows[0].mail });
        } else {
            res.status(500).send();
        }
    });
});

app.put("/visit", auth.authenticateToken, async (req, res) => {
    const check_Paziente = "SELECT id_persona, mail FROM persona WHERE mail = ? AND tipo = 'paziente'";
    const insert_visita = "INSERT INTO visita (ora_programmata, data_programmata, stato) VALUES (?, ?, 'programmata')";
    const insert_partecipa = "INSERT INTO partecipa (fk_persona, fk_visita) VALUES(?, ?)";

    try {
        let [rows] = await connection.query(check_Paziente, [req.body.visitEmail]);
        if(rows.length == 0) {
            res.status(500).send();
            return;
        }
        let paziente_id = rows[0].id_persona;
        

        let insertId = (await connection.query(insert_visita, [req.body.visitTime, req.body.visitDate]))[0].insertId;

        await connection.query(insert_partecipa, [req.payload.id, insertId]);
        await connection.query(insert_partecipa, [paziente_id, insertId]);

        res.status(200).send();
    } catch (err) {
        console.log(err);
        res.status(500).send();
    }

});

app.get("/visit", auth.authenticateToken, async (req, res) => {
    const sql_query = "SELECT v.* from visita v, partecipa p WHERE p.fk_visita = v.id_visita AND p.fk_persona = ?";

    try {
        let [rows] = await connection.query(sql_query, [req.payload.id]);
        res.status(200).send(rows);
    } catch (err) {
        console.log(err);
        res.status(500).send();
    }

});

app.get("/visitpartecipants", auth.authenticateToken, async (req, res) => {
    const sql_query = "SELECT p.* from visita v, partecipa p WHERE p.fk_visita = v.id_visita AND v.id_visita = ? AND p.fk_persona != ?";
    try {
        let [rows] = await connection.query(sql_query, [req.query.visitID, req.payload.id]);
        res.status(200).send({ fk_persona: rows[0].fk_persona});
    } catch (err) {
        console.log(err);
        res.status(500).send();
    }
});


app.listen(port, () => {
    console.log(`Express server listening on port ${port}`);
});

const server = https
    .createServer(
        // Provide the private and public key to the server by reading each
        // file's content with the readFileSync() method.
        {
            key: fs.readFileSync("ssl.key"),
            cert: fs.readFileSync("ssl.cert")
        },
        app
    )
    .listen(8080, () => {
        console.log("HTTPS server is runing at port 8080");
    });

const peerServer = ExpressPeerServer(server, {
    path: "/connect",
});

app.use("/", peerServer);


const io = new Server(server, {
    cors: {
        origin: "*",
    }
});



let counter = 0;
 
io.on('connection', (socket) => {
    console.log('Client connected:', socket.id);
 
    socket.on('join', () => {
        const room = findOrCreateRoom();
        console.log("room",room);
        socket.join(room);


  });
  socket.on('joined', () =>  {
    const room = findOrCreateRoom();
    counter = counter + 1;
    io.emit("userJoinedRoom", counter);

  });
 
 
// socket.on('signal', (data) => {
//     console.log('Segnale rievuto')
//     console.log(data)
//     const room = socket.rooms.values().next().value;
 
//     if (room) {
//         socket.to(room).emit('signal', data);
//     }
// });

    // whenever we receive a 'message' we log it out
    socket.on("message", (clientMessage) =>  {
        if (clientMessage.type === 'signal') {
          const message  = {
            message: clientMessage.message,
            author: '',
            time: Date.now(),
            type: clientMessage.type,
            room: 12345678,
          };
          if (clientMessage.for) {
            message.for = clientMessage.for;
          }

            io.to(12345678).emit("private-message", message);

        }
      });
 
socket.on('disconnect', () => {
    if (counter - 1 < 0) counter = 0;
    else counter = counter  - 1;
    console.log('Client disconnected:', socket.id);
});
});
 
function findOrCreateRoom() {
    return 12345678;
    const rooms = io.sockets.adapter.rooms;
    for (const [room, clients] of rooms) {
      if (clients.size < 2 && !room.startsWith("socket:")) {
        // console.log("Stanza: "+ rooms);
        return room;
      }
    }
    return socket.id;
  }
 



