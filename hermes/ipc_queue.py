import sqlite3
import json
import time
import os
import logging
from typing import Optional, Dict, Any

DATA_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "data")
DB_PATH = os.path.join(DATA_DIR, "ipc.sqlite")

def get_connection():
    if not os.path.exists(DATA_DIR):
        os.makedirs(DATA_DIR, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    # Ensure WAL mode for concurrency with Node.js
    conn.execute("PRAGMA journal_mode=WAL;")
    return conn

def pull_next_message(topic: str = "row-update") -> Optional[Dict[str, Any]]:
    """
    Pulls the oldest pending message for a topic, marking it as 'processing'.
    Returns a dict containing 'id' and 'payload', or None if empty.
    """
    try:
        conn = get_connection()
        cursor = conn.cursor()
        
        # Use a transaction to reliably lock/claim the next pending message
        cursor.execute("BEGIN IMMEDIATE")
        
        cursor.execute('''
            SELECT id, payload 
            FROM queue 
            WHERE topic = ? AND status = 'pending' 
            ORDER BY created_at ASC 
            LIMIT 1
        ''', (topic,))
        row = cursor.fetchone()
        
        if row:
            msg_id = row['id']
            payload = json.loads(row['payload'])
            
            # Mark as processing
            cursor.execute('''
                UPDATE queue 
                SET status = 'processing' 
                WHERE id = ?
            ''', (msg_id,))
            
            conn.commit()
            return {"id": msg_id, "payload": payload}
            
        conn.commit()
        return None
    except Exception as e:
        logging.error(f"Error pulling from IPC queue: {e}")
        return None

def ack_message(msg_id: int):
    """
    Marks a message as completed so it can be cleaned up later.
    """
    try:
        conn = get_connection()
        conn.execute('''
            UPDATE queue 
            SET status = 'completed' 
            WHERE id = ?
        ''', (msg_id,))
        conn.commit()
    except Exception as e:
        logging.error(f"Error acking message {msg_id}: {e}")

def nack_message(msg_id: int):
    """
    Marks a message as failed (or pending again if retry logic is desired).
    """
    try:
        conn = get_connection()
        conn.execute('''
            UPDATE queue 
            SET status = 'failed' 
            WHERE id = ?
        ''', (msg_id,))
        conn.commit()
    except Exception as e:
        logging.error(f"Error nacking message {msg_id}: {e}")
