require('dotenv').config();
const express = require('express');
const mysql = require('mysql2/promise');
const multer = require('multer');
const path = require('path');
const cors = require('cors');
const cloudflareStorage = require('./cloudflareStorage');
const { createClient } = require('redis');
const { ListObjectsV2Command } = require('@aws-sdk/client-s3');

const app = express();
app.use(express.json());
app.use(cors());

// Configuración Multer
const upload = multer({ dest: 'uploads/' });

// Conexión a DB (Railway)
const db = mysql.createPool({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10
});

// Conexión a Redis
const redisClient = createClient({
    url: process.env.REDIS_URL
});

redisClient.on('error', (err) => console.error('[REDIS ERROR]', err));
redisClient.on('connect', () => console.log('[REDIS CONECTADO] Memoria caché lista.'));

(async () => {
    await redisClient.connect();
})();

// =========================================================================
// HELPERS[cite: 2]
// =========================================================================
const invalidateLeadsCache = async () => {
    try {
        if (redisClient.isReady) {
            await redisClient.del('innova_leads');
            console.log("[CACHÉ] innova_leads limpiada correctamente.");
        }
    } catch (error) {
        console.warn("[REDIS WARNING] No se pudo borrar la caché:", error.message);
    }
};

const generateId9 = () => Math.floor(100000000 + Math.random() * 900000000).toString(); // 9 dígitos (Propiedades)
const generateId8 = () => Math.floor(10000000 + Math.random() * 90000000).toString();  // 8 dígitos (Asesores)

const formatArrayField = (val) => {
    if (!val) return null;
    if (typeof val === 'string' && (val.startsWith('[') || val.startsWith('{'))) return val;
    if (Array.isArray(val)) return JSON.stringify(val);
    return JSON.stringify([val]);
};

// ==========================================
// 1. MÓDULO DE ASESORES (ACTUALIZADO)
// ==========================================

// Crear Asesor con Imagen
app.post('/api/asesores', upload.single('foto_perfil'), async (req, res) => {
    try {
        const data = req.body;
        const newId = generateId8();
        let fotoUrl = null;

        // Subida de imagen a Cloudflare si existe el archivo
        if (req.file) {
            req.file.originalname = `asesor_${newId}${path.extname(req.file.originalname)}`;
            const uploadResult = await cloudflareStorage.saveFile(req.file, 'asesores'); // Carpeta 'asesores' o la que prefieras
            fotoUrl = uploadResult.filename;
        }

        const values = {
            id: newId,
            nombre: data.nombre,
            telefono: data.telefono || null,
            email: data.email || null,
            oficina: data.oficina || null,
            estado: data.estado || 'Activo',
            foto_perfil: fotoUrl
        };
        
        await db.query('INSERT INTO asesores SET ?', [values]);
        res.json({ success: true, id: newId });
    } catch (error) {
        console.error("Error creando asesor:", error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/asesores', async (req, res) => {
    try {
        const [rows] = await db.query('SELECT * FROM asesores ORDER BY fecha_creacion DESC');
        res.json({ success: true, data: rows });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Editar Asesor con Imagen Opcional
app.put('/api/asesores/:id', upload.single('foto_perfil'), async (req, res) => {
    try {
        const { id } = req.params;
        const data = req.body;
        
        // Obtener el asesor actual para conservar la foto si no se sube una nueva
        const [current] = await db.query('SELECT foto_perfil FROM asesores WHERE id = ?', [id]);
        let fotoUrl = current[0]?.foto_perfil || null;

        if (req.file) {
            req.file.originalname = `asesor_${id}_update${path.extname(req.file.originalname)}`;
            const uploadResult = await cloudflareStorage.saveFile(req.file, 'asesores');
            fotoUrl = uploadResult.filename;
        }

        await db.query(
            'UPDATE asesores SET nombre=?, telefono=?, email=?, oficina=?, estado=?, foto_perfil=? WHERE id=?', 
            [data.nombre, data.telefono, data.email, data.oficina, data.estado, fotoUrl, id]
        );
        res.json({ success: true, id });
    } catch (error) {
        console.error("Error actualizando asesor:", error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.delete('/api/asesores/:id', async (req, res) => {
    try {
        await db.query('DELETE FROM asesores WHERE id = ?', [req.params.id]);
        res.json({ success: true, message: 'Asesor eliminado' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==========================================
// 2. MÓDULO DE PROPIEDADES (Venta & Alquiler)
// ==========================================

app.post('/api/propiedades', upload.array('imagenes', 30), async (req, res) => {
    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();
        const data = req.body;
        const newId = generateId9();

        // Subida de imágenes a Cloudflare
        const imageFiles = req.files || [];
        const uploadPromises = imageFiles.map((file, index) => {
            file.originalname = `propiedad_${newId}_${index + 1}${path.extname(file.originalname)}`;
            return cloudflareStorage.saveFile(file, 'properties');
        });
        const results = await Promise.all(uploadPromises);
        const imageUrls = results.map(r => r.filename).join(',');

        const values = {
            id: newId,
            tipo: data.tipo,
            titulo: data.titulo,
            descripcion_corta: data.descripcion_corta || null,
            ubicacion: data.ubicacion || null,
            precio_soles: data.precio_soles || null,
            precio_dolares: data.precio_dolares || null,
            imagenes: imageUrls,
            imagenes_descripciones: data.imagenes_descripciones || '[]',
            mapa_direccion: data.mapa_direccion || null,
            latitude: data.latitude ? parseFloat(data.latitude) : null,
            longitude: data.longitude ? parseFloat(data.longitude) : null,
            largo_terreno: data.largo_terreno || null,
            ancho_terreno: data.ancho_terreno || null,
            area_total: data.area_total || null,
            area_ocupada: data.area_ocupada || null,
            habitaciones: data.habitaciones || null,
            habitacion_principal_con_bano: data.habitacion_principal_con_bano || 'No',
            banos: data.banos || null,
            pisos: data.pisos || null,
            estacionamiento: data.estacionamiento || 'No',
            antiguedad: data.antiguedad || null,
            areas_verdes: data.areas_verdes || 'No',
            amoblado: data.amoblado || 'No',
            fecha_publicacion: data.fecha_publicacion || new Date(),
            estado: data.estado || 'Activo',
            id_vendedor: data.id_vendedor || null,
            lugares_cercanos: formatArrayField(data.lugares_cercanos),
            servicios_basicos: formatArrayField(data.servicios_basicos),
            fecha_compra: data.fecha_compra || null,
            orden_imagenes: data.orden_imagenes || null,
            operacion: data.operacion || 'venta',
            destacada: data.destacada === '1' ? 1 : 0, 
            video_url: data.video_url || null,
            seo_title: data.seo_title || null,
            seo_description: data.seo_description || null,
            keywords: data.keywords || null
        };

        await connection.query('INSERT INTO propiedades SET ?', [values]);
        await connection.commit();
        res.json({ success: true, id: newId });
    } catch (error) {
        await connection.rollback();
        console.error("Error creando propiedad:", error);
        res.status(500).json({ success: false, error: error.message });
    } finally {
        connection.release();
    }
});

app.put('/api/propiedades/:id', upload.array('imagenes', 30), async (req, res) => {
    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();
        const { id } = req.params;
        const data = req.body;

        const [existing] = await connection.query('SELECT imagenes FROM propiedades WHERE id = ?', [id]);
        if (existing.length === 0) return res.status(404).json({ error: 'Propiedad no encontrada' });

        let finalImageUrls = [];
        const imageFiles = req.files || [];
        let uploadedFilenames = [];

        if (imageFiles.length > 0) {
            const uploadPromises = imageFiles.map((file, index) => {
                file.originalname = `propiedad_${id}_new_${Date.now()}_${index + 1}${path.extname(file.originalname)}`;
                return cloudflareStorage.saveFile(file, 'properties');
            });
            const results = await Promise.all(uploadPromises);
            uploadedFilenames = results.map(r => r.filename); 
        }

        if (data.orden_imagenes) {
            try {
                const orden = typeof data.orden_imagenes === 'string' ? JSON.parse(data.orden_imagenes) : data.orden_imagenes;
                let newFileIndex = 0;
                finalImageUrls = orden.map(item => {
                    if (item.tipo === 'existing') {
                        return item.url_o_nombre.replace(/https?:\/\/[^\/]+\//, '').trim();
                    } else {
                        const filename = uploadedFilenames[newFileIndex++];
                        return filename || '';
                    }
                }).filter(url => url !== ''); 
            } catch (e) {
                finalImageUrls = existing[0].imagenes ? existing[0].imagenes.split(',') : [];
                if (uploadedFilenames.length > 0) finalImageUrls.push(...uploadedFilenames);
            }
        } else {
            finalImageUrls = existing[0].imagenes ? existing[0].imagenes.split(',') : [];
            if (uploadedFilenames.length > 0) finalImageUrls.push(...uploadedFilenames);
        }

        const updateValues = {
            tipo: data.tipo,
            titulo: data.titulo,
            descripcion_corta: data.descripcion_corta || null,
            ubicacion: data.ubicacion || null,
            precio_soles: data.precio_soles || null,
            precio_dolares: data.precio_dolares || null,
            imagenes: finalImageUrls.join(','),
            imagenes_descripciones: data.imagenes_descripciones || '[]',
            mapa_direccion: data.mapa_direccion || null,
            latitude: data.latitude ? parseFloat(data.latitude) : null,
            longitude: data.longitude ? parseFloat(data.longitude) : null,
            largo_terreno: data.largo_terreno || null,
            ancho_terreno: data.ancho_terreno || null,
            area_total: data.area_total || null,
            area_ocupada: data.area_ocupada || null,
            habitaciones: data.habitaciones || null,
            habitacion_principal_con_bano: data.habitacion_principal_con_bano || 'No',
            banos: data.banos || null,
            pisos: data.pisos || null,
            estacionamiento: data.estacionamiento || 'No',
            antiguedad: data.antiguedad || null,
            areas_verdes: data.areas_verdes || 'No',
            amoblado: data.amoblado || 'No',
            id_vendedor: data.id_vendedor || null,
            lugares_cercanos: formatArrayField(data.lugares_cercanos),
            servicios_basicos: formatArrayField(data.servicios_basicos),
            operacion: data.operacion || 'venta',
            destacada: data.destacada === '1' ? 1 : 0, 
            video_url: data.video_url || null,
            seo_title: data.seo_title || null,
            seo_description: data.seo_description || null,
            keywords: data.keywords || null
        };

        await connection.query('UPDATE propiedades SET ? WHERE id = ?', [updateValues, id]);
        await connection.commit();
        res.json({ success: true, id });
    } catch (error) {
        await connection.rollback();
        console.error("Error actualizando propiedad:", error);
        res.status(500).json({ success: false, error: error.message });
    } finally {
        connection.release();
    }
});

app.get('/api/propiedades', async (req, res) => {
    try {
        const query = `
            SELECT p.*, 
                   a.nombre as vendedor_nombre, a.telefono as vendedor_telefono, a.email as vendedor_email
            FROM propiedades p
            LEFT JOIN asesores a ON p.id_vendedor = a.id
            ORDER BY p.fecha_publicacion DESC
        `;
        const [rows] = await db.query(query);
        res.json({ success: true, data: rows });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/propiedades/:id', async (req, res) => {
    try {
        const [rows] = await db.query(`
            SELECT p.*, 
                   a.nombre as vendedor_nombre, a.telefono as vendedor_telefono, a.email as vendedor_email, a.oficina as vendedor_oficina
            FROM propiedades p
            LEFT JOIN asesores a ON p.id_vendedor = a.id
            WHERE p.id = ?
        `, [req.params.id]);

        if (rows.length === 0) return res.status(404).json({ success: false, message: 'Propiedad no encontrada' });

        const propiedad = rows[0];
        ['lugares_cercanos', 'servicios_basicos'].forEach(campo => {
            if (propiedad[campo]) {
                try {
                    propiedad[campo] = typeof propiedad[campo] === 'string' ? JSON.parse(propiedad[campo]) : propiedad[campo];
                } catch (e) { propiedad[campo] = []; }
            } else {
                propiedad[campo] = [];
            }
        });

        res.json({ success: true, data: propiedad });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.delete('/api/propiedades/:id', async (req, res) => {
    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();
        const { id } = req.params;

        const [propiedades] = await connection.query('SELECT imagenes FROM propiedades WHERE id = ?', [id]);
        if (propiedades.length === 0) {
            await connection.rollback();
            return res.status(404).json({ success: false, error: 'Propiedad no encontrada' });
        }

        const imagenes = propiedades[0].imagenes ? propiedades[0].imagenes.split(',').map(img => img.trim()) : [];
        if (imagenes.length > 0) {
            const deletePromises = imagenes.map(filename => cloudflareStorage.deleteFile(filename).catch(() => null));
            await Promise.all(deletePromises);
        }

        await connection.query('DELETE FROM propiedades WHERE id = ?', [id]);
        await connection.commit();
        res.json({ success: true, message: 'Propiedad eliminada por completo' });
    } catch (error) {
        await connection.rollback();
        res.status(500).json({ success: false, error: error.message });
    } finally {
        connection.release();
    }
});

// ==========================================
// 3. MÓDULO DE LEADS[cite: 2]
// ==========================================

app.post('/api/leads', async (req, res) => {
    try {
        const data = req.body;
        const values = {
            nombres_apellidos: data.nombres_apellidos,
            celular: data.celular,
            email: data.email || null,
            intencion: data.intencion || null,
            tipo_propiedad: data.tipo_propiedad || null,
            ciudad: data.ciudad || null,
            mensaje: data.mensaje || null,
            origen: data.origen || 'Modal Vender',
            id_propiedad_interes: data.id_propiedad_interes || null,
            estado_lead: 'Nuevo'
        };

        await db.query('INSERT INTO leads SET ?', [values]);
        await invalidateLeadsCache();
        res.json({ success: true, message: 'Lead registrado' });
    } catch (error) {
        console.error("Error guardando lead:", error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/leads', async (req, res) => {
    try {
        let cachedLeads = null;
        try {
            if (redisClient.isReady) cachedLeads = await redisClient.get('innova_leads');
        } catch (redisError) {}

        if (cachedLeads) {
            return res.json({ success: true, data: JSON.parse(cachedLeads), source: 'cache' });
        }

        const query = `
            SELECT l.*, p.titulo as propiedad_titulo 
            FROM leads l
            LEFT JOIN propiedades p ON l.id_propiedad_interes = p.id
            ORDER BY l.fecha_registro DESC
        `;
        const [leadsRows] = await db.query(query);

        try {
            if (redisClient.isReady) await redisClient.setEx('innova_leads', 60, JSON.stringify(leadsRows));
        } catch (redisError) {}

        res.json({ success: true, data: leadsRows, source: 'db' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.patch('/api/leads/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { estado_lead } = req.body;
        await db.query('UPDATE leads SET estado_lead = ? WHERE id = ?', [estado_lead, id]);
        await invalidateLeadsCache();
        res.json({ success: true, message: 'Lead actualizado' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==========================================
// 4. MÓDULO DE BLOGS[cite: 2]
// ==========================================

app.post('/api/blogs', upload.single('imagen_principal'), async (req, res) => {
    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();
        const data = req.body;
        const newId = crypto.randomUUID().substring(0, 20); // VARCHAR(20)

        let filename = null;
        if (req.file) {
            req.file.originalname = `blog_${newId}_${Date.now()}${path.extname(req.file.originalname)}`;
            const uploadResult = await cloudflareStorage.saveFile(req.file, 'blog');
            filename = uploadResult.filename;
        }

        const values = {
            id: newId,
            titulo: data.titulo,
            slug: data.slug,
            extracto: data.extracto || null,
            contenido: data.contenido,
            imagen_principal: filename,
            categoria: data.categoria || 'General',
            tiempo_lectura: parseInt(data.tiempo_lectura) || null,
            seo_title: data.seo_title || null,
            seo_description: data.seo_description || null,
            seo_keywords: data.seo_keywords || null,
            estado: data.estado || 'publicado',
            fecha_publicacion: data.fecha_publicacion || new Date(),
            fecha_actualizacion: new Date()
        };

        await connection.query('INSERT INTO blogs SET ?', [values]);
        await connection.commit();
        res.json({ success: true, id: newId });
    } catch (error) {
        await connection.rollback();
        res.status(500).json({ success: false, error: error.message });
    } finally {
        connection.release();
    }
});

app.put('/api/blogs/:id', upload.single('imagen_principal'), async (req, res) => {
    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();
        const { id } = req.params;
        const data = req.body;

        const [existing] = await connection.query('SELECT imagen_principal FROM blogs WHERE id = ?', [id]);
        if (existing.length === 0) return res.status(404).json({ error: 'Blog no encontrado' });

        let filename = existing[0].imagen_principal;
        
        if (req.file) {
            req.file.originalname = `blog_${id}_new_${Date.now()}${path.extname(req.file.originalname)}`;
            const uploadResult = await cloudflareStorage.saveFile(req.file, 'blog');
            filename = uploadResult.filename;
        }

        const updateValues = {
            titulo: data.titulo,
            slug: data.slug,
            extracto: data.extracto || null,
            contenido: data.contenido,
            imagen_principal: filename,
            categoria: data.categoria || 'General',
            tiempo_lectura: parseInt(data.tiempo_lectura) || null,
            seo_title: data.seo_title || null,
            seo_description: data.seo_description || null,
            seo_keywords: data.seo_keywords || null,
            estado: data.estado || 'publicado',
            fecha_actualizacion: new Date()
        };

        await connection.query('UPDATE blogs SET ? WHERE id = ?', [updateValues, id]);
        await connection.commit();
        res.json({ success: true, id });
    } catch (error) {
        await connection.rollback();
        res.status(500).json({ success: false, error: error.message });
    } finally {
        connection.release();
    }
});

app.get('/api/blogs', async (req, res) => {
    try {
        const [rows] = await db.query('SELECT * FROM blogs ORDER BY fecha_publicacion DESC');
        res.json({ success: true, data: rows });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/blogs/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const [rows] = await db.query('SELECT * FROM blogs WHERE id = ? OR slug = ?', [id, id]);
        if (rows.length === 0) return res.status(404).json({ success: false, message: 'Artículo no encontrado' });
        res.json({ success: true, data: rows[0] });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.delete('/api/blogs/:id', async (req, res) => {
    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();
        const { id } = req.params;

        const [blogs] = await connection.query('SELECT imagen_principal FROM blogs WHERE id = ?', [id]);
        if (blogs.length === 0) {
            await connection.rollback();
            return res.status(404).json({ success: false, error: 'Artículo no encontrado' });
        }

        const imagen = blogs[0].imagen_principal;
        if (imagen) {
            await cloudflareStorage.deleteFile(imagen).catch(() => null);
        }

        await connection.query('DELETE FROM blogs WHERE id = ?', [id]);
        await connection.commit();
        res.json({ success: true, message: 'Artículo eliminado' });
    } catch (error) {
        await connection.rollback();
        res.status(500).json({ success: false, error: error.message });
    } finally {
        connection.release();
    }
});

app.post('/api/upload-media', upload.single('imagen'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, error: 'No se recibió ninguna imagen.' });
        }
 
        const uniqueId = crypto.randomUUID().substring(0, 12);
        req.file.originalname = `blog_content_${uniqueId}_${Date.now()}${path.extname(req.file.originalname)}`;
 
        const uploadResult = await cloudflareStorage.saveFile(req.file, 'blog');
 
        // Ajusta CLOUDFLARE_BASE a la misma base que usas para imagen_principal
        const url = `https://innova.afygroup.net/principales/${uploadResult.filename}`;
 
        res.json({ success: true, url, filename: uploadResult.filename });
    } catch (error) {
        console.error('Error al subir imagen de contenido:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/media', async (req, res) => {
    try {
        const allImages = [];
        let continuationToken = undefined;
 
        do {
            const command = new ListObjectsV2Command({
                Bucket: cloudflareStorage.bucket,       // reutiliza el mismo bucket que ya usas
                Prefix: 'principales/',                  // ahí es donde caen las imágenes de blog
                MaxKeys: 1000,
                ContinuationToken: continuationToken,
            });
 
            const response = await cloudflareStorage.s3Client.send(command);
 
            const imageExtensions = /\.(jpe?g|png|webp|gif|avif|svg)$/i;
            const items = (response.Contents || [])
                .filter((obj) => {
                    const fileName = obj.Key.split('/').pop() || '';
                    // Solo imágenes, y solo las que vienen del módulo de blogs
                    // (originalname empieza con 'blog_', tal como lo arma /api/blogs y /api/upload-media)
                    return imageExtensions.test(fileName) && fileName.startsWith('blog_');
                })
                .map((obj) => ({
                    key: obj.Key,
                    url: `${cloudflareStorage.publicUrl}/${obj.Key}`,
                    size: obj.Size,
                    lastModified: obj.LastModified,
                }));
 
            allImages.push(...items);
            continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
        } while (continuationToken);
 
        allImages.sort((a, b) => new Date(b.lastModified) - new Date(a.lastModified));
 
        res.json({ success: true, data: allImages });
    } catch (error) {
        console.error('Error al listar imágenes de R2:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Innova Server corriendo en puerto ${PORT}`));
