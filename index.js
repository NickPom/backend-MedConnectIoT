require('dotenv').config();

const express = require('express');
const fileUpload = require("express-fileupload");
const cors = require('cors');
const https = require("https");
const fs = require("fs");
const path = require("path");
const bodyParser = require('body-parser');
const mysql = require('mysql2/promise');
const PDFDocument = require('pdfkit');
const { v4: uuidv4 } = require('uuid');
const { ExpressPeerServer } = require("peer");
const { Server } = require("socket.io");
const csv = require("csv-stringify");

const auth = require('./auth');

const connection = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USERNAME,
    password: process.env.DB_PASSWORD,
    database: process.env.DB,
    port: process.env.DB_PORT,
    dateStrings: true
});

const app = express()
    .use(cors({
        origin: "*"
    }))
    .use(bodyParser.json())
    .use(fileUpload({
        createParentPath: true,
    }))
    .use(express.static(path.join(__dirname, 'public/')));

app.post("/upload", (req, res) => {
    if (!req.files) {
        return res.status(400).send();
    }

    const file = req.files.file;
    const newFilename = uuidv4() + path.extname(file.name);
    const filepath = path.join(__dirname, 'public') + "/files/" + newFilename;
    const name = path.basename(file.name, path.extname(file.name));

    file.mv(filepath, async (err) => {
        if (err) {
            return res.status(500).send(err);
        }
        try {
            const type = 3; //Tipo file
            const uri = "/files/" + newFilename;
            const sql_query = "INSERT INTO documentazione (nome_documento, timestamp_creazione, fk_tipologia_documento, fk_visita, uri_documento) VALUES (?, NOW(), ?, ?, ?)";
            await connection.query(sql_query, [name, type, Number(req.body.visitID), uri]);
    
            res.status(200).send({ uri: uri });
        } catch (error) {
            console.error(error);
            res.status(500).send();
        }  
    });


});

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
    const sql_query = "SELECT nome, cognome, id_persona, mail, tipo FROM persona WHERE mail = ?";
    connection.query(sql_query, [req.payload.email]).then(([rows]) => {
        if (rows.length > 0) {
            res.status(200).send({ nome: rows[0].nome, cognome: rows[0].cognome, id_persona: rows[0].id_persona, email: rows[0].mail, tipo: rows[0].tipo });
        } else {
            res.status(500).send();
        }
    });
});

app.put("/user", async (req, res) => {
    const sql_query = "INSERT into persona (nome, cognome, mail, password, telefono, data_nascita, provincia, cap, tipo, fk_specializzazione, fk_caregiver) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";
    let spec = null;
    let caregiver = null;
    if(req.body.fk_specializzazione != '') {
        spec = req.body.fk_specializzazione;
    }
    
    if(req.body.fk_caregiver != '') {
        caregiver = req.body.fk_caregiver;
    }

    try {
        await connection.query(sql_query, [
            req.body.nome,
            req.body.cognome,
            req.body.mail,
            req.body.password,
            req.body.telefono,
            req.body.data_nascita,
            req.body.provincia,
            req.body.cap,
            req.body.tipo,
            spec,
            caregiver
        ]);
        res.status(200).json();
    } catch (error) {
        console.error(error);
        res.status(500).json();
    }
});

app.get("/specialties", async (req, res) => {
    const sql_query = "SELECT * from specializzazione";
    try {
        let [rows] = await connection.query(sql_query);
        res.status(200).json(rows);
    } catch (error) {
        console.error(error);
        res.status(500).json();
    }
});

app.put("/visit", auth.authenticateToken, async (req, res) => {
    const check = "SELECT id_persona, mail FROM persona WHERE mail = ?";
    const insert_visita = "INSERT INTO visita (ora_programmata, data_programmata, stato) VALUES (?, ?, 'programmata')";
    const insert_partecipa = "INSERT INTO partecipa (fk_persona, fk_visita) VALUES(?, ?)";

    try {
        let [rows] = await connection.query(check, [req.body.visitEmail]);
        if (rows.length == 0) {
            res.status(500).send();
            return;
        }
        let other_id = rows[0].id_persona;


        let insertId = (await connection.query(insert_visita, [req.body.visitTime, req.body.visitDate]))[0].insertId;

        await connection.query(insert_partecipa, [req.payload.id, insertId]);
        await connection.query(insert_partecipa, [other_id, insertId]);

        res.status(200).send({ visitID: insertId });
    } catch (err) {
        console.log(err);
        res.status(500).send();
    }

});

app.get("/visit", auth.authenticateToken, async (req, res) => {
    const sql_query = "SELECT v.* from visita v, partecipa p WHERE p.fk_visita = v.id_visita AND p.fk_persona = ? ORDER BY v.stato ASC, v.data_programmata DESC";

    try {
        let [rows] = await connection.query(sql_query, [req.payload.id]);
        res.status(200).send(rows);
    } catch (err) {
        console.log(err);
        res.status(500).send();
    }

});

app.get("/visitCount", auth.authenticateToken, async (req, res) => {
    let user;
    if(req.query.user == undefined) {
        user = req.payload.id;
    } else {
        user = req.query.user;
    }
    const sql_query = "SELECT COUNT(v.id_visita) as conto from visita v, partecipa p WHERE p.fk_visita = v.id_visita AND p.fk_persona = ?";

    try {
        let [rows] = await connection.query(sql_query, [user]);
        res.status(200).send(rows[0]);
    } catch (err) {
        console.log(err);
        res.status(500).send();
    }
});

app.post("/visitRange", auth.authenticateToken, async (req, res) => {
    let user;
    if(req.body.user_id == undefined) {
        user = req.payload.id;
    } else {
        user = req.body.user_id;
    }
    const sql_query = "SELECT v.* from visita v, partecipa p WHERE p.fk_visita = v.id_visita AND p.fk_persona = ? ORDER BY v.stato ASC, v.data_programmata DESC LIMIT ? OFFSET ?";
    try {
        let [rows] = await connection.query(sql_query, [user, req.body.pageSize, req.body.pageIndex * req.body.pageSize]);
        res.status(200).send(rows);
    } catch (err) {
        console.log(err);
        res.status(500).send();
    }

});

app.delete("/visit", auth.authenticateToken, async (req, res) => {
    const partecipa_query = "DELETE FROM partecipa WHERE fk_visita = ?";
    const visit_query = "DELETE FROM visita  WHERE id_visita  = ?";
    try {
        await connection.query(partecipa_query, [req.body.id_visita]);
        await connection.query(visit_query, [req.body.id_visita]);
        res.status(200).send();
    } catch (err) {
        console.log(err);
        res.status(500).send();
    }
});

app.post("/visit", auth.authenticateToken, async (req, res) => {
    const sql_query = "UPDATE honesto.visita SET ora_programmata = ?, data_programmata = ?, stato = ? WHERE id_visita = ?";
    try {
        await connection.query(sql_query, [req.body.ora, req.body.data,  req.body.state, req.body.id_visita]);
        res.status(200).send();
    } catch (err) {
        console.log(err);
        res.status(500).send();
    }
});

app.get("/visitpartecipants", auth.authenticateToken, async (req, res) => {
    const sql_query = "SELECT p.* from visita v, partecipa p WHERE p.fk_visita = v.id_visita AND v.id_visita = ? AND p.fk_persona != ?";
    try {
        let [rows] = await connection.query(sql_query, [req.query.visitID, req.payload.id]);
        res.status(200).send({ fk_persona: rows[0].fk_persona });
    } catch (err) {
        console.log(err);
        res.status(500).send();
    }
});

app.post("/createdoc", auth.authenticateToken, async (req, res) => {
    const doc = new PDFDocument;
    const filename = uuidv4();
    const title = req.body.title;
    const text = req.body.text;
    const userid = req.payload.id;
    let nome = "";
    let cognome = "";
    try {
        const sql_query = "SELECT nome, cognome FROM persona WHERE id_persona = ?";
        const [rows] = await connection.query(sql_query, [userid]);
        nome = rows[0].nome;
        cognome = rows[0].cognome;
    } catch (error) {
        console.error(error);
        res.status(500).send();
    }

    doc.pipe(fs.createWriteStream(path.join(__dirname, 'public/files/') + filename + '.pdf'));
    doc.font(path.join(__dirname, 'public/') + "fonts/calibri.ttf");
    
    doc.image(path.join(__dirname, 'public/') + "images/logo.png", 80, 57, { width: 200 })
		.fillColor('#444444')
		.fontSize(10)
		.text(nome + " " + cognome, 160, 65, { align: 'right' })
		.text('28/03/2023', 160, 80, { align: 'right' })
		.moveDown();

    doc
        .font(path.join(__dirname, 'public/') + 'fonts/calibrib.ttf', 18)
        .text("Titolo: " + title, 80, 150)
        .moveDown()
        .text("Descrizione:")
        .font(path.join(__dirname, 'public/') + 'fonts/calibri.ttf', 10)
        .text(text, {
            align: 'justify',
            columns: 1,
            height: 300,
            ellipsis: true
        });

    doc.end();

    try {
        const uri = "/files/" + filename +".pdf";
        const type = 2; //Tipo taccuino
        const sql_query = "INSERT INTO documentazione (nome_documento, timestamp_creazione, fk_tipologia_documento, fk_visita, uri_documento) VALUES (?, NOW(), ?, ?, ?)";
        await connection.query(sql_query, [title, type, req.body.visitID, uri]);

        res.status(200).send({ uri: uri });
    } catch (error) {
        console.error(error);
        res.status(500).send();
    }  
});

app.get("/documents", auth.authenticateToken, async (req, res) => {
    const sql_query = "SELECT DISTINCT d.nome_documento, d.timestamp_creazione, d.uri_documento FROM documentazione d, visita v , partecipa p , persona p2 WHERE d.fk_visita = v.id_visita AND p.fk_visita = v.id_visita AND p.fk_persona = p2.id_persona  AND p2.id_persona = ?";

    try {
        let [rows] = await connection.query(sql_query, [req.payload.id]);
        res.status(200).send(rows);
    } catch (err) {
        console.log(err);
        res.status(500).send();
    }

});

app.post("/documents", auth.authenticateToken, async (req, res) => {
    const sql_query = "SELECT DISTINCT d.nome_documento, d.timestamp_creazione, d.uri_documento FROM documentazione d, visita v , partecipa p , persona p2 WHERE d.fk_visita = v.id_visita AND p.fk_visita = v.id_visita AND p.fk_persona = p2.id_persona  AND p2.id_persona = ?";

    try {
        let [rows] = await connection.query(sql_query, [req.body.patientID]);
        res.status(200).send(rows);
    } catch (err) {
        console.log(err);
        res.status(500).send();
    }

});

app.post("/updatevisit", auth.authenticateToken, async (req, res) => {
    const sql_query = "UPDATE partecipa p SET p.ora = ?, p.data = ? WHERE p.ora IS NULL AND p.data IS NULL AND p.fk_persona = ? AND p.fk_visita = ?";
    const datetime = new Date().toISOString().slice(0, 19).replace('T', ' ');
    const date = datetime.split(' ')[0];
    const time = datetime.split(' ')[1];

    try {
        await connection.query(sql_query, [time, date, req.payload.id, req.body.visitID]);
        res.status(200).send();
    } catch (err) {
        console.log(err);
        res.status(500).send();
    }
});

app.post("/startvisit", auth.authenticateToken, async (req, res) => {
    const sql_query = "UPDATE visita v SET v.stato = 'in corso' WHERE v.id_visita = ?";
    try {
        await connection.query(sql_query, [req.body.visitID]);
        res.status(200).send();
    } catch (err) {
        console.log(err);
        res.status(500).send();
    }
});

app.post("/stopvisit", auth.authenticateToken, async (req, res) => {
    const sql_query = "UPDATE visita v SET v.stato = 'terminata' WHERE v.id_visita = ?";
    try {
        await connection.query(sql_query, [req.body.visitID]);
        res.status(200).send();
    } catch (err) {
        console.log(err);
        res.status(500).send();
    }
});

app.get("/patients", auth.authenticateToken, async (req, res) => {
    const sql_query = "SELECT DISTINCT  p.nome, p.cognome, p.id_persona, p.mail " +
        "FROM persona p, partecipa p2 " +
        "WHERE p2.fk_persona = p.id_persona AND p2.fk_persona != ? AND p2.fk_visita IN " +
        "(SELECT v.id_visita  from visita v, partecipa p WHERE p.fk_visita = v.id_visita AND p.fk_persona = ?)";

    try {
        let [rows] = await connection.query(sql_query, [req.payload.id, req.payload.id]);
        res.status(200).send(rows);
    } catch (err) {
        console.log(err);
        res.status(500).send();
    }
});

app.get("/doctors", async (req, res) => {
    const sql_query = "SELECT id_persona, nome, cognome, mail, telefono, data_nascita, provincia, cap, fk_specializzazione FROM persona WHERE tipo = 'medico'";

    try {
        let [rows] = await connection.query(sql_query);
        res.status(200).send(rows);
    } catch (err) {
        console.log(err);
        res.status(500).send();
    }
});

app.get("/caregivers", async (req, res) => {
    const sql_query = "SELECT id_persona, nome, cognome, mail FROM persona WHERE tipo = 'caregiver'";

    try {
        let [rows] = await connection.query(sql_query);
        res.status(200).send(rows);
    } catch (err) {
        console.log(err);
        res.status(500).send();
    }
});

app.get("/peopleassisted", auth.authenticateToken, async (req, res) => {
    const sql_query = "SELECT persona.* FROM persona WHERE fk_caregiver = ?";
    try {
        let [rows] = await connection.query(sql_query, [req.payload.id]);
        res.status(200).send(rows);
    } catch (err) {
        console.log(err);
        res.status(500).send();
    }
});

app.post("/patient", auth.authenticateToken, async (req, res) => {
    const sql_query = "SELECT p.nome, p.cognome, p.id_persona, p.mail FROM persona p WHERE p.id_persona=?";

    try {
        let [rows] = await connection.query(sql_query, [req.body.id]);
        res.status(200).send(rows[0]);
    } catch (err) {
        console.log(err);
        res.status(500).send();
    }
});

app.get("/allpatients", auth.authenticateToken, async (req, res) => {
    const sql_query = "SELECT p.id_persona, p.nome, p.cognome, p.mail FROM persona p WHERE p.tipo = 'paziente'";

    try {
        let [rows] = await connection.query(sql_query);
        res.status(200).send(rows);
    } catch (err) {
        console.log(err);
        res.status(500).send();
    }
});

app.post("/visitname", auth.authenticateToken, async (req, res) => {
   const sql_query = "SELECT p.* FROM persona p, visita v, partecipa p2 WHERE p2.fk_visita = v.id_visita AND p2.fk_persona = p.id_persona AND p.id_persona != ? AND v.id_visita = ?"; 
   try {
    let [rows] = await connection.query(sql_query, [req.payload.id, req.body.visitid]);
    res.status(200).send(rows[0]);
} catch (err) {
    console.log(err);
    res.status(500).send();
}
});

app.delete("/deleteuser", auth.authenticateToken, async (req, res) => {
    const deleteDocuments_query = "DELETE FROM documentazione d WHERE d.fk_visita  IN (SELECT v.id_visita  FROM visita v, partecipa p  WHERE v.id_visita = p.fk_visita AND p.fk_persona = ?)";
    const visits_query = "SELECT v.id_visita FROM visita v, partecipa p  WHERE v.id_visita = p.fk_visita AND p.fk_persona = ?";
    const deleteUsers_query = "DELETE FROM persona WHERE id_persona = ?";

    const deleteVisit_query = "DELETE FROM visita WHERE id_visita = ?";
    const deleteJoined_query = "DELETE FROM partecipa where fk_visita = ?";

    try {

        await connection.query(deleteDocuments_query, [req.payload.id]);

        let [visits] = await connection.query(visits_query, [req.payload.id]);

        for (let i = 0; i < visits.length; i++) {
            await connection.query(deleteJoined_query, [visits[i].id_visita]);
        }

        for (let i = 0; i < visits.length; i++) {
            await connection.query(deleteVisit_query, [visits[i].id_visita]);
        }

        await connection.query(deleteUsers_query, [req.payload.id]);

        res.status(200).send({});

    } catch (err) {
        console.log(err);
        res.status(500).send();
    }

});

app.get("/takeout", auth.authenticateToken, async (req, res) => {

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="' + 'download-' + Date.now() + '.csv"');
    
    const columns = [
        "id",
        "name",
        "surname",
        "email",
        "telephone",
        "birth",
        "state",
        "cap",
        "type",
        "visits"
    ];

    const userQuery = "SELECT * FROM persona WHERE id_persona = ?";
    const visitsQuery = "SELECT v.* FROM persona p, visita v, partecipa p2  WHERE p.id_persona = ? AND p2.fk_persona = p.id_persona AND p2.fk_visita = v.id_visita ";

    let [rows] = await connection.query(userQuery, [req.payload.id]);
    let user = rows[0];

    let [visits] = await connection.query(visitsQuery, [req.payload.id]);

    const data = [{
        id: user.id_persona,
        name: user.nome,
        surname: user.cognome,
        email: user.mail,
        telephone: user.telefono,
        birth: user.data_nascita,
        state: user.provincia,
        cap: user.cap,
        type: user.tipo,
        visits: visits,
    }];

    csv.stringify(data, { header: true, columns: columns }).pipe(res);
});

app.post('/iot', (req, res) => {
    let body = ''; // Variabile per memorizzare il corpo della richiesta

    req.on('data', (chunk) => {
        body += chunk.toString(); // Aggiungi ogni pezzo di dati al corpo della richiesta
    });

    req.on('end', () => {
        console.log('Corpo della richiesta:', body);
        res.send('Dati ricevuti con successo!');
    });  
});

// app.get("/alldevice", async (req, res) => {
//     const sql_query = "select ni.id, ni.tipo, td.nome from nodo_iot ni, tipologia_device td WHERE ni.tipo  = td.ID ORDER BY ni.id  ASC";
//     try {
//         let [rows] = await connection.query(sql_query);
//         res.status(200).send(rows);
//     } catch (err) {
//         console.log(err);
//         res.status(500).send();
//     }
// });

app.get("/alldevicetype", async (req, res) => {
    const sql_query = "SELECT * FROM tipologia_device";
    try {
        let [rows] = await connection.query(sql_query);
        res.status(200).send(rows);
    } catch (err) {
        console.log(err);
        res.status(500).send();
    }
});

app.get("/aviabledevice", async (req, res) => {
    const sql_query = "SELECT nodo_iot.id AS id_device, td.id AS id_tipologia FROM nodo_iot INNER JOIN tipologia_device td ON nodo_iot.tipo = td.ID LEFT JOIN abbinato ON abbinato.fk_nodo_iot = nodo_iot.id WHERE (abbinato.fk_nodo_iot IS NULL OR abbinato.data_fine < CURDATE());";

    try {
        let [rows] = await connection.query(sql_query);
        res.status(200).send(rows);
    } catch (err) {
        console.log(err);
        res.status(500).send();
    }
});

app.get("/alldevice", async (req, res) => {
    const sql_query = "SELECT persona.id_persona, persona.nome, persona.cognome, td.id AS id_tipologia, abbinato.data_inizio, abbinato.data_fine, nodo_iot.id AS id_device FROM nodo_iot LEFT JOIN (SELECT * FROM abbinato WHERE abbinato.data_fine IS NULL OR abbinato.data_fine >= CURDATE()) AS abbinato ON abbinato.fk_nodo_iot = nodo_iot.id LEFT JOIN tipologia_device td ON nodo_iot.tipo = td.ID LEFT JOIN persona ON abbinato.fk_paziente = persona.id_persona ORDER BY nodo_iot.id  ASC;";

    try {
        let [rows] = await connection.query(sql_query);
        res.status(200).send(rows);
    } catch (err) {
        console.log(err);
        res.status(500).send();
    }
});

app.get("/pairedDevice", async (req, res) => {
    const sql_query = "SELECT persona.id_persona, persona.nome, persona.cognome, abbinato.data_inizio, abbinato.data_fine,nodo_iot.id as id_device, td.nome as tipologia FROM abbinato, persona, nodo_iot, tipologia_device td where (data_fine >= CURDATE() and data_inizio <= CURDATE()) and abbinato.fk_paziente = persona.id_persona and abbinato.fk_nodo_iot = nodo_iot.id and nodo_iot.tipo = td.ID;";
    try {
        let [rows] = await connection.query(sql_query);
        res.status(200).send(rows);
    } catch (err) {
        console.log(err);
        res.status(500).send();
    }
});


app.put("/createdevice", async (req, res) => {
    const check = "SELECT id FROM nodo_iot WHERE id = ?";
    const sql_query = "INSERT INTO nodo_iot (id, tipo) VALUES (?, ?)";
    console.log(req.body);
    let [rows] = await connection.query(check, [req.body.id_device]);
        if (rows.length != 0) {
            res.status(409).json({error: "Il dispositivo è già assegnato"});
            return;
        }
    try {
        await connection.query(sql_query, [
            req.body.id_device,
            req.body.id_tipologia,     
        ]);
        res.status(200).json();
    } catch (error) {
        console.error(error);
        res.status(500).json();
    }
});



app.put("/pairDevice", async (req, res) => {
   
    const sql_query = "INSERT INTO abbinato (fk_paziente, fk_nodo_iot, data_inizio, data_fine) VALUES (?, ?, ?, ?);";

    console.log(req.body);
    try {
        await connection.query(sql_query, [req.body.id_persona,req.body.id_device, req.body.data_inizio,req.body.data_fine,]);

        res.status(200).json();
    } catch (error) {
        console.error(error);
        res.status(500).json();
    }
});

app.post("/updatedevice", auth.authenticateToken, async (req, res) => {
    const sql_query = "UPDATE abbinato SET fk_paziente = ?, data_inizio = ?, data_fine = ? WHERE fk_paziente = ? AND fk_nodo_iot = ? LIMIT 1;";
    
    if(req.body.id_cambiato==null){
        req.body.id_cambiato= await req.body.id_persona;
    }
    console.log(req.body);
    try {
        
        await connection.query(sql_query, [req.body.id_persona, req.body.data_inizio,req.body.data_fine, req.body.id_cambiato, req.body.id_device, ]);
        res.status(200).send();
        
    } catch (err) {
        console.log(err);
        res.status(500).send();
    }
    //console.log(res);
    
});




//--------------------------------------------------------------------------------------
app.listen(process.env.EXPRESS_PORT, () => {
    console.log(`Express server listening on port ${process.env.EXPRESS_PORT}`);
});

const server = https
    .createServer(
        {
            key: fs.readFileSync(process.env.SSL_KEY),
            cert: fs.readFileSync(process.env.SSL_CERT)
        },
        app
    );

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
 
    socket.on('join', (stanza) => {
        const room = stanza;
        console.log("room",room);
        socket.join(room);


  });
  socket.on('joined', (stanza) =>  {
    
    counter = io.sockets.adapter.rooms.get(stanza).size;
    console.log("Utenti: "+counter);
    io.to(stanza).emit("userJoinedRoom", counter);

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
    socket.on("message", (room, clientMessage) =>  {
        if (clientMessage.type === 'signal') {
          const message  = {
            message: clientMessage.message,
            author: '',
            time: Date.now(),
            type: clientMessage.type,
            room: room,
          };
          if (clientMessage.for) {
            message.for = clientMessage.for;
          }

            io.to(room).emit("private-message", message);

        }
    });

    socket.on('disconnect', () => {
       
        console.log('Client disconnected:', socket.id);
    });
});

server.listen(process.env.HTTPS_PORT, () => {
    console.log(`HTTPS server is running at port ${process.env.HTTPS_PORT}`);
});
